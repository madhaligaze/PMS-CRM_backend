CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rights" jsonb DEFAULT '{"sections":{},"powers":[]}'::jsonb NOT NULL,
	"require_totp" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "access" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "position_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "rights" jsonb DEFAULT '{"sections":{},"powers":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "positions_org_name_uq" ON "positions" USING btree ("org_id",lower("name")) WHERE "positions"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Роли прежней схемы становятся должностями с теми же правами: каждой
-- организации - свой список, дальше владелец правит его сам.
INSERT INTO positions (id, org_id, name, rights, require_totp, sort)
SELECT gen_random_uuid(), o.id, m.name, m.rights, m.require_totp, m.sort
FROM orgs o
CROSS JOIN (VALUES
  ('Управляющий', 1, true, '{"sections":{"bookings":"edit","frontdesk":"edit","guests":"edit","folio":"edit","cash":"edit","housekeeping":"edit","cleaning":"edit","maintenance":"edit","attendance":"edit","staff":"edit","reports":"view","settings":"edit","audit":"view"},"powers":["discount_unlimited","special_price","special_price_approve","refund_unlimited","storno","storno_closed","checkout_debt","guest_admin","block_rooms"]}'::jsonb),
  ('Старший администратор', 2, false, '{"sections":{"bookings":"edit","frontdesk":"edit","guests":"edit","folio":"edit","cash":"edit","housekeeping":"edit","maintenance":"view","attendance":"view","staff":"view","reports":"view"},"powers":["special_price","storno","checkout_debt","guest_admin","block_rooms"]}'::jsonb),
  ('Администратор ресепшена', 3, false, '{"sections":{"bookings":"edit","frontdesk":"edit","guests":"edit","folio":"edit","cash":"edit","housekeeping":"view","maintenance":"view"},"powers":[]}'::jsonb),
  ('Оператор колл-центра', 4, false, '{"sections":{"bookings":"edit","guests":"edit"},"powers":[]}'::jsonb),
  ('Менеджер по залам', 5, false, '{"sections":{"bookings":"view","guests":"edit"},"powers":[]}'::jsonb),
  ('Горничная', 6, false, '{"sections":{"cleaning":"edit"},"powers":[]}'::jsonb),
  ('Супервайзер хозслужбы', 7, false, '{"sections":{"housekeeping":"edit","cleaning":"edit","maintenance":"view"},"powers":["block_rooms"]}'::jsonb),
  ('Техник', 8, false, '{"sections":{"maintenance":"edit"},"powers":[]}'::jsonb),
  ('Бухгалтер', 9, true, '{"sections":{"bookings":"view","guests":"view","folio":"view","cash":"view","attendance":"view","reports":"view"},"powers":[]}'::jsonb)
) AS m(name, sort, require_totp, rights);
--> statement-breakpoint
UPDATE memberships ms
SET access = CASE WHEN ms.role = 'owner' THEN 'owner' ELSE 'staff' END,
    position_id = p.id,
    rights = p.rights
FROM users u,
     positions p,
     (VALUES
       ('owner', 'Управляющий'),
       ('senior_admin', 'Старший администратор'),
       ('front_desk', 'Администратор ресепшена'),
       ('call_center', 'Оператор колл-центра'),
       ('events_manager', 'Менеджер по залам'),
       ('housekeeper', 'Горничная'),
       ('hk_supervisor', 'Супервайзер хозслужбы'),
       ('technician', 'Техник'),
       ('accountant', 'Бухгалтер')
     ) AS rm(role, name)
WHERE u.id = ms.user_id
  AND rm.role = ms.role::text
  AND p.org_id = u.org_id
  AND p.name = rm.name;
--> statement-breakpoint
UPDATE users u
SET totp_required = true
FROM memberships ms
LEFT JOIN positions p ON p.id = ms.position_id
WHERE ms.user_id = u.id AND (ms.access IN ('owner', 'admin') OR p.require_totp);