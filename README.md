# Bizdin Auyl API

API системы управления гостиницей Bizdin Auyl (PMS + CRM): Node 22, Fastify 5,
Zod 4, Drizzle ORM, PostgreSQL 17. Самостоятельный сервис со своим образом;
веб-клиент живёт отдельно и ходит сюда через прокси `/api`.

> Этот репозиторий - зеркало папки `backend/` монорепозитория
> [PMS-CRM](https://github.com/madhaligaze/PMS-CRM). Правки вносятся там, сюда
> они попадают командой `git subtree push` (см. README монорепозитория).

## Запуск

```bash
pnpm install
docker compose up -d db        # Postgres на localhost:5433
cp .env.example .env
pnpm db:reset                  # схема, миграции и демо-данные
pnpm dev                       # API на :4000, документация - /api/docs
```

Целиком в Docker: `docker compose up -d` (база и API на :4000).

## Тесты

```bash
pnpm typecheck
pnpm test        # vitest на базе bizdin_test: сценарии, права, гонки, нагрузка
```

## Railway

Сервис собирается по `Dockerfile`, настройки сборки и проверки готовности - в
`railway.json` (проверка: `GET /health/ready`). Миграции применяются при старте.

Переменные сервиса API (в одном проекте Railway с базой и вебом; имена сервисов
в ссылках `${{...}}` - как они названы в проекте):

| Переменная | Значение |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `JWT_SECRET` | случайная строка от 48 символов (кнопка Generate в Railway) |
| `PORT` | `4000` |
| `HOST` | `::` - внутренняя сеть Railway может быть только IPv6 |
| `MIGRATE_ON_START` | `true` |
| `SEED_DEMO_IF_EMPTY` | `true` только для стенда показа: демо в пустую базу при старте (пароль `demo12345`) |
| `COOKIE_SECURE` | `true` |
| `PUBLIC_API_URL` | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` - адрес веба: браузер видит API через него |
| `CORS_ORIGINS` | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` |
| `REQUIRE_TOTP_FOR_PRIVILEGED` | `true` (для демо можно `false`) |
| `FILES_DIR` | `/data/files` |
| `RAILWAY_RUN_UID` | `0` - том Railway принадлежит root, иначе сканы не запишутся |

Том (Volume) подключается к сервису на `/data`: без него сканы документов и фото
пропадают при каждом деплое. Публичный домен API не обязателен: веб ходит к нему
по внутренней сети Railway. Сервис `web` с доменом создаётся раньше `api`: иначе
ссылка в `PUBLIC_API_URL` пустая, и API не стартует. Пошагово - в
`docs/deploy-railway.md` монорепозитория.
