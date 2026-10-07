-- Инварианты, которые держит сама база, а не код приложения.
-- Сообщения исключений - на русском: они доходят до журнала и до разработчика.

-- ── Двойная бронь невозможна ────────────────────────────────────────────────
-- room_occupancy ведут триггеры ниже. Пересечение [starts_on, ends_on) одного
-- номера отбрасывается EXCLUDE-ограничением (код ошибки 23P01), и API отвечает 409.
ALTER TABLE room_occupancy ADD CONSTRAINT room_occupancy_dates_chk CHECK (ends_on > starts_on);
--> statement-breakpoint
ALTER TABLE room_occupancy ADD CONSTRAINT room_occupancy_source_chk CHECK ((booking_id IS NULL) <> (block_id IS NULL));
--> statement-breakpoint
ALTER TABLE room_occupancy ADD CONSTRAINT room_occupancy_no_overlap
  EXCLUDE USING gist (room_id WITH =, daterange(starts_on, ends_on, '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE room_occupancy ADD CONSTRAINT room_occupancy_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings(id);
--> statement-breakpoint
ALTER TABLE room_occupancy ADD CONSTRAINT room_occupancy_block_fk FOREIGN KEY (block_id) REFERENCES room_blocks(id);
--> statement-breakpoint
ALTER TABLE room_occupancy ADD CONSTRAINT room_occupancy_room_fk FOREIGN KEY (room_id) REFERENCES rooms(id);
--> statement-breakpoint

CREATE FUNCTION sync_booking_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Выселенные остаются в занятости: история не может получить двойную бронь задним числом.
  IF NEW.status IN ('tentative', 'confirmed', 'checked_in', 'checked_out') THEN
    INSERT INTO room_occupancy (property_id, room_id, starts_on, ends_on, booking_id)
    VALUES (NEW.property_id, NEW.room_id, NEW.arrival, NEW.departure, NEW.id)
    ON CONFLICT (booking_id) DO UPDATE
      SET room_id = EXCLUDED.room_id, starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on;
  ELSE
    DELETE FROM room_occupancy WHERE booking_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bookings_occupancy
  AFTER INSERT OR UPDATE OF status, room_id, arrival, departure ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_booking_occupancy();
--> statement-breakpoint

CREATE FUNCTION sync_block_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO room_occupancy (property_id, room_id, starts_on, ends_on, block_id)
    VALUES (NEW.property_id, NEW.room_id, NEW.starts_on, NEW.ends_on, NEW.id)
    ON CONFLICT (block_id) DO UPDATE
      SET room_id = EXCLUDED.room_id, starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on;
  ELSE
    DELETE FROM room_occupancy WHERE block_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER room_blocks_occupancy
  AFTER INSERT OR UPDATE OF is_active, room_id, starts_on, ends_on ON room_blocks
  FOR EACH ROW EXECUTE FUNCTION sync_block_occupancy();
--> statement-breakpoint

-- ── Проверки данных ─────────────────────────────────────────────────────────
ALTER TABLE bookings ADD CONSTRAINT bookings_dates_chk CHECK (departure > arrival);
--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT bookings_guests_chk CHECK (adults >= 1 AND children >= 0);
--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT bookings_discount_chk CHECK (discount_percent IS NULL OR discount_percent BETWEEN 0 AND 100);
--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT bookings_cancel_reason_chk CHECK (status NOT IN ('cancelled', 'no_show') OR cancel_reason IS NOT NULL);
--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT bookings_price_reason_chk CHECK (price_mode = 'rate' OR price_reason IS NOT NULL);
--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT bookings_rating_chk CHECK (rating IS NULL OR rating BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE room_blocks ADD CONSTRAINT room_blocks_dates_chk CHECK (ends_on > starts_on);
--> statement-breakpoint
ALTER TABLE rate_prices ADD CONSTRAINT rate_prices_dates_chk CHECK (valid_to >= valid_from);
--> statement-breakpoint
ALTER TABLE rate_prices ADD CONSTRAINT rate_prices_amount_chk CHECK (amount >= 0);
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_amount_chk CHECK (amount > 0);
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_storno_reason_chk CHECK (storno_of IS NULL OR storno_reason IS NOT NULL);
--> statement-breakpoint
ALTER TABLE folio_items ADD CONSTRAINT folio_items_storno_reason_chk CHECK (storno_of IS NULL OR storno_reason IS NOT NULL);
--> statement-breakpoint
ALTER TABLE hk_tasks ADD CONSTRAINT hk_tasks_skip_reason_chk CHECK (status <> 'skipped' OR skip_reason IS NOT NULL);
--> statement-breakpoint
ALTER TABLE guests ADD CONSTRAINT guests_blacklist_reason_chk CHECK (NOT blacklisted OR blacklist_reason IS NOT NULL);
--> statement-breakpoint
ALTER TABLE attendance_events ADD CONSTRAINT attendance_correction_reason_chk CHECK (corrects_id IS NULL OR reason IS NOT NULL);
--> statement-breakpoint
ALTER TABLE cash_shifts ADD CONSTRAINT cash_shifts_discrepancy_comment_chk
  CHECK (status = 'open' OR discrepancy = 0 OR discrepancy_comment IS NOT NULL);
--> statement-breakpoint

-- Одна карточка на документ: «одна запись гостя» из ТЗ держит база.
CREATE UNIQUE INDEX guests_document_uq ON guests (org_id, coalesce(citizenship, ''), doc_number_norm)
  WHERE merged_into IS NULL AND doc_number_norm IS NOT NULL;
--> statement-breakpoint
CREATE INDEX guests_name_trgm ON guests
  USING gin ((lower(last_name || ' ' || first_name || ' ' || coalesce(middle_name, ''))) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX companies_name_trgm ON companies USING gin ((lower(name)) gin_trgm_ops);
--> statement-breakpoint

-- ── Ничего не удаляется бесследно ───────────────────────────────────────────
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Таблица % только для добавления: % запрещён', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

-- Оплата неизменна после проведения: меняются только фискальные поля и
-- отметка о сторно (один раз). Удалять нельзя.
CREATE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Оплату нельзя удалить: только сторно с причиной' USING ERRCODE = 'P0001';
  END IF;
  IF row(NEW.amount, NEW.kind, NEW.method, NEW.payment_type, NEW.shift_id, NEW.booking_id, NEW.group_id,
         NEW.created_by, NEW.created_at, NEW.storno_of, NEW.storno_reason, NEW.payer, NEW.company_id)
     IS DISTINCT FROM
     row(OLD.amount, OLD.kind, OLD.method, OLD.payment_type, OLD.shift_id, OLD.booking_id, OLD.group_id,
         OLD.created_by, OLD.created_at, OLD.storno_of, OLD.storno_reason, OLD.payer, OLD.company_id) THEN
    RAISE EXCEPTION 'Проведённую оплату нельзя изменить: только сторно' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.reversed_by IS NOT NULL AND NEW.reversed_by IS DISTINCT FROM OLD.reversed_by THEN
    RAISE EXCEPTION 'Оплата уже сторнирована' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard();
--> statement-breakpoint

-- Принять оплату можно только в открытую смену. FOR SHARE ждёт закрытие
-- смены, если оно идёт параллельно, и после него увидит статус closed.
CREATE FUNCTION payments_require_open_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM cash_shifts WHERE id = NEW.shift_id AND status = 'open' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Кассовая смена закрыта: оплату принять нельзя' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_open_shift BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_require_open_shift();
--> statement-breakpoint

CREATE FUNCTION folio_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Начисление нельзя удалить: только сторно с причиной' USING ERRCODE = 'P0001';
  END IF;
  IF row(NEW.amount, NEW.unit_amount, NEW.quantity, NEW.kind, NEW.booking_id, NEW.service_date,
         NEW.created_by, NEW.created_at, NEW.storno_of, NEW.storno_reason, NEW.description)
     IS DISTINCT FROM
     row(OLD.amount, OLD.unit_amount, OLD.quantity, OLD.kind, OLD.booking_id, OLD.service_date,
         OLD.created_by, OLD.created_at, OLD.storno_of, OLD.storno_reason, OLD.description) THEN
    RAISE EXCEPTION 'Начисление нельзя изменить: только сторно' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.reversed_by IS NOT NULL AND NEW.reversed_by IS DISTINCT FROM OLD.reversed_by THEN
    RAISE EXCEPTION 'Начисление уже сторнировано' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER folio_items_immutable BEFORE UPDATE OR DELETE ON folio_items
  FOR EACH ROW EXECUTE FUNCTION folio_items_guard();
--> statement-breakpoint

-- Закрытая Z-отчётом смена неизменна. Единственное, что можно один раз
-- дописать, - отметку о приёме смены следующим администратором.
CREATE FUNCTION cash_shifts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Кассовую смену нельзя удалить' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'closed' THEN
    IF OLD.accepted_by IS NULL
       AND NEW.accepted_by IS NOT NULL
       AND row(NEW.status, NEW.closed_at, NEW.closed_by, NEW.counted_cash, NEW.expected_cash, NEW.discrepancy,
               NEW.discrepancy_comment, NEW.z_report::text, NEW.handed_over_to, NEW.opening_cash)
           IS NOT DISTINCT FROM
           row(OLD.status, OLD.closed_at, OLD.closed_by, OLD.counted_cash, OLD.expected_cash, OLD.discrepancy,
               OLD.discrepancy_comment, OLD.z_report::text, OLD.handed_over_to, OLD.opening_cash) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Смена закрыта Z-отчётом и не может быть изменена' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cash_shifts_immutable BEFORE UPDATE OR DELETE ON cash_shifts
  FOR EACH ROW EXECUTE FUNCTION cash_shifts_guard();
--> statement-breakpoint

-- ── Outbox → LISTEN/NOTIFY ──────────────────────────────────────────────────
-- NOTIFY транзакционный: уведомление уходит только после коммита. Несколько
-- экземпляров API слушают канал и раздают события своим SSE-клиентам.
CREATE FUNCTION outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox', json_build_object(
    'id', NEW.id, 'propertyId', NEW.property_id, 'topic', NEW.topic, 'entityId', NEW.entity_id
  )::text);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbox_events_notify AFTER INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_notify();
