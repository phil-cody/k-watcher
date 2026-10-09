# Перенос бота на VPS-сервер

Пошаговая инструкция: от пустого сервера до работающего бота, который переживает перезагрузку
и обновляется без потери состояния. Все команды проверены по текущей версии проекта
(Node.js ≥ 20.6, зависимостей нет).

- [0. Что понадобится](#0-что-понадобится)
- [1. Выбор сервера](#1-выбор-сервера)
- [2. Первичная настройка VPS](#2-первичная-настройка-vps)
- [3. Установка Node.js](#3-установка-nodejs)
- [4. Доставка кода на сервер](#4-доставка-кода-на-сервер)
- [5. Секреты и конфигурация](#5-секреты-и-конфигурация)
- [6. Проверка перед запуском](#6-проверка-перед-запуском)
- [7. Первый запуск вручную](#7-первый-запуск-вручную)
- [8. Автозапуск через systemd](#8-автозапуск-через-systemd)
- [9. Логи и мониторинг](#9-логи-и-мониторинг)
- [10. Обновление версии](#10-обновление-версии)
- [11. Резервное копирование](#11-резервное-копирование)
- [12. Безопасность сервера](#12-безопасность-сервера)
- [13. Частые проблемы](#13-частые-проблемы)
- [14. Чек-лист переноса](#14-чек-лист-переноса)

---

## 0. Что понадобится

| Что | Зачем |
|---|---|
| VPS с Linux (Ubuntu 22.04/24.04 или Debian 12) | бот работает сутками, окно опроса 05:00–20:00 МСК |
| SSH-доступ (ключ, не пароль) | установка и управление |
| Репозиторий с кодом (Git) или архив | доставка проекта |
| `TELEGRAM_BOT_TOKEN` | из @BotFather, тот же, что на локальной машине |
| `TELEGRAM_ALLOWED_USER_ID` и chat id | кому бот пишет |
| Часовой пояс сервера | бот считает окно в `Europe/Moscow` независимо от пояса, но логи читать проще, если пояс совпадает |

**Минимальные требования к железу:** 1 vCPU, 512 МБ RAM, 5 ГБ диска. Бот не делает тяжёлых
вычислений: один HTTP-запрос раз в 4–10 минут и разбор HTML в памяти.

**Про часовой пояс.** Окно опроса задано в `config/default.json` → `schedule.timezone`
(`Europe/Moscow`) и считается через `Intl` с явной зоной. Поэтому пояс сервера на работу
не влияет — можно оставить UTC. Но если хотите, чтобы время в логах совпадало с московским:

```bash
sudo timedatectl set-timezone Europe/Moscow
timedatectl            # проверить
```

---

## 1. Выбор сервера

Подойдёт любой провайдер: Timeweb, Selectel, Hetzner, Aeza, VDSina. Важные критерии:

1. **Российский IP** — желательно: Kwork российский сервис, зарубежные IP чаще попадают под
   антибот-проверки, а это прямая причина остановки опроса.
2. **Стабильный канал** — бот делает ≤ 12 запросов за цикл, трафик копеечный.
3. **Не «шаред-хостинг»** — нужен root/sudo и systemd.

> ⚠️ Не покупайте прокси и не меняйте IP «на лету» для обхода блокировок: это прямо
> запрещено согласованным объёмом доступа. Если Kwork ограничивает доступ — вопрос решается
> частотой запросов и обращением в поддержку Kwork, а не сменой идентичности.

---

## 2. Первичная настройка VPS

```bash
# 1. Обновление системы
sudo apt update && sudo apt upgrade -y

# 2. Базовые пакеты
sudo apt install -y git curl ca-certificates tzdata

# 3. Отдельный пользователь для бота (не работаем под root)
sudo adduser --disabled-password --gecos "" kwork
sudo usermod -aG sudo kwork

# 4. Ключ для входа (со своей машины!)
#    ssh-keygen -t ed25519 -C "kwork-vps"        # если ключа ещё нет
#    ssh-copy-id kwork@<IP_СЕРВЕРА>

# 5. Отключаем вход по паролю (после того как убедились, что ключ работает)
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

**Файрвол** — бот не принимает входящих соединений, нужен только SSH:

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status
```

Порт dashboard (8787) **не открывайте**: он без пароля.

---

## 3. Установка Node.js

Нужен Node.js 20.6+ (проверено на 24.x). Через NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # должно быть v22.x или новее
npm -v
which node   # обычно /usr/bin/node — именно этот путь указываем в systemd-юните
```

Если вы ставили Node через `nvm` (как часто бывает на локальной машине), путь будет другим
(`~/.nvm/versions/node/vXX/bin/node`). В systemd **нельзя** ссылаться на `nvm`-путь:
используйте системную установку из apt/NodeSource, а `ExecStart` укажите как
`/usr/bin/node src/index.js bot`.

Никаких `npm install` для проекта не требуется: зависимостей нет, `package.json` пустой по
`dependencies`. Это упрощает перенос и убирает риск supply-chain атак.

---

## 4. Доставка кода на сервер

### Вариант А — через Git (рекомендуется)

На локальной машине:

```bash
cd /путь/к/проекту
git init                       # если ещё не инициализирован
git add -A
git commit -m "kwork watcher bot: рабочая версия"
git remote add origin git@github.com:<вы>/kwork-watcher-bot.git
git push -u origin main
```

> Убедитесь, что `.gitignore` исключает `.env` и `data/` — они не должны попасть в репозиторий.
> Проверка: `git status --porcelain | grep -E '\.env|data/'` не должен ничего вернуть.

На сервере:

```bash
sudo mkdir -p /opt/kwork-watcher
sudo chown kwork:kwork /opt/kwork-watcher
su - kwork
git clone git@github.com:<вы>/kwork-watcher-bot.git /opt/kwork-watcher/app
cd /opt/kwork-watcher/app
node --test                    # тесты должны пройти без сети
```

### Вариант Б — архивом

```bash
# локально
tar --exclude='.env' --exclude='data' --exclude='.git' -czf kwork-bot.tar.gz .
# на сервере
mkdir -p /opt/kwork-watcher/app && tar -xzf kwork-bot.tar.gz -C /opt/kwork-watcher/app
```

---

## 5. Секреты и конфигурация

### 5.1 Файл .env

Создаём на сервере (никогда не коммитим):

```bash
cd /opt/kwork-watcher/app
cp .env.example .env
chmod 600 .env
nano .env
```

Заполняем:

```ini
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
TELEGRAM_ALLOWED_USER_ID=<ваш числовой id>
TELEGRAM_CHAT_ID=<id чата, необязательно>

# Необязательно: свой файл формулировок (имя подпадает под .gitignore)
# TEXTS_FILE=config/local.texts.json

DATA_DIR=data
```

**Как узнать chat id:** проще всего запустить бота локально и отправить `/start` — тогда
`TELEGRAM_CHAT_ID` не нужен, бот запомнит чат. Для `poll` без приёма команд chat id обязателен.

**Несколько пользователей.** `TELEGRAM_ALLOWED_USER_ID` — это владелец бота (если не задан,
владельцем станет первый написавший). Остальные подключаются сами: пишут боту `/start`, и
доступ открывается сразу — подтверждение не нужно (событие логируется). Каждый пользователь
загружает **свой** профиль командой `/profile upload` (файл JSON), он хранится в
`data/profiles/<id>.json`; **общего/запасного профиля нет**. Пока профиля нет, задания
пользователю не отправляются, а раз в сутки приходит напоминание. Доступ хранится в
`data/telegram-state.json` и попадает в бэкап вместе с остальным состоянием. Чтобы закрыть
доступ (публичное окружение): `config/default.json` → `"telegram": { "autoApprove": false }`.

**Меню команд.** При запуске `bot` приложение публикует команды в Telegram (`setMyCommands`),
поэтому они видны в интерфейсе. Тексты — `config/texts.json` → `commands.telegramMenu`,
ограничить набор — `config.telegram.menuFilter`.

**Права на файлы:**

```bash
chmod 700 /opt/kwork-watcher/app/data 2>/dev/null || true
```

### 5.2 Основной конфиг

`config/default.json` — проверьте перед запуском:

```jsonc
{
  "source": {
    "enabled": true,                       // живой опрос разрешён
    "baseUrl": "https://kwork.ru",         // список заданий; категории добавляются ?c=<id>
    "pagination": { "enabled": true, "maxPagesPerUrl": 6 },
    "pruneMissingJobs": true
  },
  "schedule": {
    "timezone": "Europe/Moscow",
    "windowStart": "05:00",
    "windowEnd": "20:00",
    "minIntervalSeconds": 240,             // нельзя меньше 240
    "maxIntervalSeconds": 600,             // нельзя больше 600
    "firstRequestNoDelay": true
  }
}
```

### 5.3 Перенос состояния с локальной машины (необязательно)

Если хотите сохранить уже собранный список задач, чтобы бот не присылал их повторно:

```bash
# локально: посмотреть размер
du -sh data/
# скопировать на сервер (data/ в git не хранится)
scp data/seen-index.json data/processed-jobs.jsonl data/messages-log.jsonl \
    data/state.json kwork@<IP>:/opt/kwork-watcher/app/data/
```

> Если переносите `state.json`, обратите внимание на `pendingNotifications`: недоставленные
> сообщения отправятся при первом же цикле. Это нормально.

### 5.4 Локальные тексты (если правили формулировки)

```bash
cd /opt/kwork-watcher/app
cp config/texts.json config/local.texts.json    # имя подпадает под config/local.*.json в .gitignore
nano config/local.texts.json                    # оставляем только те ключи, которые меняем
echo "TEXTS_FILE=config/local.texts.json" >> .env
```

Файл можно делать частичным: ключи, которых в нём нет, берутся из `config/texts.json`.
Проверить, что ничего не забыто: `node --test test/texts.test.js` (в вашем файле ключи не
проверяются, но проверяется, что базовые тексты целы).

---

## 6. Проверка перед запуском

```bash
cd /opt/kwork-watcher/app
node --test                          # все тесты зелёные, сеть не нужна
node src/index.js config-check       # без ошибок
node src/index.js config-check --live  # проверка готовности к живому опросу
node src/index.js plan               # печатает, что именно бот будет запрашивать
```

Последняя команда — обязательная: **прочитайте список URL, окно и интервал**. Если что-то не
совпадает с согласованным доступом — не запускайте живой режим.

---

## 7. Первый запуск вручную

Запускаем в `tmux`/`screen` или просто в терминале, чтобы увидеть первый цикл:

```bash
cd /opt/kwork-watcher/app
node src/index.js poll
```

Ожидаемый лог (первый запрос идёт сразу, дальше пауза 240–600 с; при открытии и закрытии
окна опроса бот пришлёт отдельные сообщения в чат):

```
[info] Запуск режима poll {"mode":"poll","method":"heuristic","notifications":"включены"}
[info] Первый запрос после старта: пауза не требуется
[info] Цикл завершён: запросов 4, карточек 35, новых 35, повторов 0, удалено устаревших 0,
       всего задач 35 | все: карточек 12, c=79: карточек 5, c=38: карточек 17 (страниц 2), ...
```

(Точные числа зависят от выдачи Kwork: на первой странице категории приходит 12 заданий,
остальные — на следующих страницах, которые бот добирает по `pagination.last_page`.)

Остановить: `Ctrl+C`. Бот корректно завершится (сохранит offset и состояние).

Если хотите принимать команды `/status`, `/pause`, `/resume` — запускайте `bot` вместо `poll`:

```bash
node src/index.js bot
```

> **Важно:** один и тот же токен нельзя опрашивать из двух мест. Если бот ещё работает на
> локальной машине — остановите его, иначе в логе будет
> `Conflict: terminated by other getUpdates request`.

---

## 8. Автозапуск через systemd

### 8.1 Юнит

Создаём файл `/etc/systemd/system/kwork-bot.service`:

```ini
[Unit]
Description=Kwork watcher bot (Telegram-уведомления о новых заданиях)
Documentation=file:/opt/kwork-watcher/app/docs/DEPLOY-VPS.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kwork
Group=kwork
WorkingDirectory=/opt/kwork-watcher/app

# Режим bot: планировщик + приём команд Telegram.
# Если команды не нужны — замените на: ExecStart=/usr/bin/node src/index.js poll
ExecStart=/usr/bin/node src/index.js bot

# Секреты читаются из .env самим приложением; никаких Environment= с токенами.

# Аккуратное завершение: бот сохранит offset и состояние по SIGTERM.
KillSignal=SIGTERM
TimeoutStopSec=30

Restart=on-failure
RestartSec=30

# Ограничения безопасности: процессу не нужны права выше своих файлов.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/kwork-watcher/app/data

StandardOutput=journal
StandardError=journal
SyslogIdentifier=kwork-bot

[Install]
WantedBy=multi-user.target
```

### 8.2 Запуск

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kwork-bot
sudo systemctl status kwork-bot
journalctl -u kwork-bot -n 30 --no-pager
```

### 8.3 Управление

```bash
sudo systemctl stop kwork-bot        # остановить
sudo systemctl start kwork-bot       # запустить
sudo systemctl restart kwork-bot     # перезапустить (после правки конфига)
sudo systemctl status kwork-bot      # состояние
journalctl -u kwork-bot -f           # смотреть лог в реальном времени
```

### 8.4 Почему такой набор ограничений

- `ProtectSystem=full` — код в `/opt` доступен только на чтение, кроме `ReadWritePaths`.
- `ReadWritePaths=/opt/kwork-watcher/app/data` — единственный каталог, куда бот пишет.
- `NoNewPrivileges` — процесс не может повысить права.
- Секреты не передаются через `Environment=`: они не видны в `systemctl show` и
  `/proc/<pid>/environ` для других пользователей.

---

## 9. Логи и мониторинг

### 9.1 Чтение логов

```bash
journalctl -u kwork-bot --since "1 hour ago"           # за час
journalctl -u kwork-bot | grep "Цикл завершён"         # только сводки циклов
journalctl -u kwork-bot | grep -E "остановлен|ОШИБКА"  # проблемы
```

Сводка цикла — главный индикатор здоровья:

```
Цикл завершён: запросов 4, карточек 46, новых 3, повторов 43, удалено устаревших 0,
всего задач 35 | все: карточек 12, c=79: карточек 5, ...
```

Что смотреть:

| Признак в логе | Что значит |
|---|---|
| `новых 0, повторов N` | норма: новых заданий нет |
| `Окно опроса закрыто` | норма после 20:00 МСК |
| `ожидание открытия окна` | норма до 05:00 МСК |
| `Опрос остановлен` + причина | **требует внимания**, бот прислал диагностику в Telegram |
| `Conflict: terminated by other getUpdates` | запущена вторая копия бота с тем же токеном |
| `в выдаче заявлено X, забрано Y` | увеличьте `pagination.maxPagesPerUrl` |

### 9.2 Ограничение размера журнала

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/kwork.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=200M
SystemMaxFileSize=20M
MaxRetentionSec=2week
EOF
sudo systemctl restart systemd-journald
```

### 9.3 Внешний мониторинг (необязательно)

Простой health-check через systemd уже есть (`Restart=on-failure`). Если нужен внешний
контроль — используйте «dead man's switch» (healthchecks.io, Uptime Kuma): скрипт раз в час
проверяет, что бот жив, и отправляет пинг:

```bash
# /opt/kwork-watcher/healthcheck.sh
#!/usr/bin/env bash
set -euo pipefail
systemctl is-active --quiet kwork-bot || { echo "kwork-bot не работает"; exit 1; }
# окно опроса: вне 05:00–20:00 МСК проверка не нужна
curl -fsS -m 10 "https://hc-ping.com/<ваш-uuid>" >/dev/null
```

Не открывайте порт dashboard в интернет и не публикуйте вывод `status` публично: там
заголовки заданий и данные заказчиков.

---

## 10. Обновление версии

### 10.1 Обновление из Git

```bash
cd /opt/kwork-watcher/app
sudo systemctl stop kwork-bot

# бэкап состояния и конфигов
tar -czf ~/kwork-backup-$(date +%F-%H%M).tar.gz data/ .env config/

git fetch origin
git pull --ff-only

node --test                      # тесты на новой версии
node src/index.js config-check   # конфиг всё ещё валиден

sudo systemctl start kwork-bot
journalctl -u kwork-bot -n 20 --no-pager
```

### 10.2 Откат

```bash
cd /opt/kwork-watcher/app
git log --oneline -5             # найти предыдущий коммит
git checkout <коммит>
sudo systemctl restart kwork-bot
```

### 10.3 Обновление из архива

```bash
cd /opt/kwork-watcher/app
sudo systemctl stop kwork-bot
tar -xzf ~/kwork-bot-new.tar.gz -C /opt/kwork-watcher/app
node --test && sudo systemctl start kwork-bot
```

### 10.4 Обновление Node.js

```bash
node -v                          # текущая
# при необходимости переустановить через NodeSource (см. раздел 3)
# Юнит ссылается на /usr/bin/node — путь не меняется
sudo systemctl restart kwork-bot
```

---

## 11. Резервное копирование

Что важно сохранить:

| Файл | Почему |
|---|---|
| `data/seen-index.json` | список текущих задач: без него бот пришлёт всё заново |
| `data/processed-jobs.jsonl` | история обработки |
| `data/state.json` | очередь недоставленных, причина последней остановки |
| `.env` | секреты (храните отдельно, не в общем архиве!) |
| `config/*.json` | ваш конфиг, маппинг категорий, локальные тексты |
| `data/profiles/*.json` | профили пользователей бота (загружены через `/profile upload`) |
| `data/telegram-state.json` | доступ пользователей, offset, отпечатки меню команд |

Скрипт `/opt/kwork-watcher/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
APP=/opt/kwork-watcher/app
DEST=/opt/kwork-watcher/backups
mkdir -p "$DEST"
tar -czf "$DEST/kwork-data-$(date +%F).tar.gz" \
  -C "$APP" data config/default.json
# хранить 14 дней
find "$DEST" -name 'kwork-data-*.tar.gz' -mtime +14 -delete
echo "готово: $DEST/kwork-data-$(date +%F).tar.gz"
```

Расписание через cron:

```bash
chmod +x /opt/kwork-watcher/backup.sh
crontab -e
# ежедневно в 04:30 (до открытия окна опроса)
30 4 * * * /opt/kwork-watcher/backup.sh >> /var/log/kwork-backup.log 2>&1
```

Восстановление:

```bash
sudo systemctl stop kwork-bot
tar -xzf /opt/kwork-watcher/backups/kwork-data-2026-10-08.tar.gz -C /opt/kwork-watcher/app
sudo systemctl start kwork-bot
```

> `.env` в бэкап не включаем: держите копию токена в менеджере паролей. Если токен утёк —
> перевыпустите его у @BotFather (`/revoke`) и обновите `.env`.

---

## 12. Безопасность сервера

Чек-лист для этого проекта:

1. **SSH**: только ключи, `PermitRootLogin no`, root-вход закрыт.
2. **UFW**: входящие закрыты, кроме SSH.
3. **Файрвол + порты**: dashboard слушает `127.0.0.1` (по умолчанию). Если нужен доступ
   снаружи — только через SSH-туннель:
   ```bash
   ssh -L 8787:127.0.0.1:8787 kwork@<IP>     # затем открыть http://127.0.0.1:8787
   ```
   Не публикуйте порт напрямую: страница без пароля и содержит данные заданий.
4. **Права**: `.env` — `chmod 600`, `data/` — `chmod 700`, владелец `kwork`.
5. **Обновления**: `sudo apt update && sudo apt upgrade -y` раз в месяц; `unattended-upgrades`
   для автоматических security-патчей.
6. **Секреты**: только в `.env`; никаких токенов в `config/*.json`, в git и в systemd.
   Проверка: `git grep -nE '[0-9]{6,}:[A-Za-z0-9_-]{20,}'` не должен ничего найти.
7. **Логи**: не содержат токенов и полного HTML — это гарантируется тестами
   (`test/security.test.js`), но не публикуйте журнал целиком в открытые каналы.
8. **fail2ban** (по желанию): защита SSH от перебора.

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

---

## 13. Частые проблемы

### 13.1 Бот не стартует, exit code 2

Смотрим причину: `journalctl -u kwork-bot -n 20`. Типичные варианты:

| Сообщение | Решение |
|---|---|
| `TELEGRAM_BOT_TOKEN не задан` | заполнить `.env` |
| `TELEGRAM_ALLOWED_USER_ID не задан` | указать свой id |
| `Неизвестен Telegram chat id` | запустить `bot` и отправить `/start`, либо задать `TELEGRAM_CHAT_ID` |
| `source.enabled = false` | включить источник в `config/default.json` |
| `Интервал 240–600 с вне...` | вернуть допустимые значения интервала |

### 13.2 Бот молчит, хотя задания есть

```bash
node src/index.js status                 # есть ли задачи в индексе
cat data/state.json | grep -A5 pending   # не застряла ли очередь отправки
journalctl -u kwork-bot | grep -i "не удалось отправить"
```

Если в `pendingNotifications` есть записи — Telegram недоступен или chat id неверный.

### 13.3 `Conflict: terminated by other getUpdates request`

Запущена вторая копия бота с тем же токеном (например, локальная машина или вторая служба).
Остановите все, кроме одной:

```bash
sudo systemctl stop kwork-bot       # на сервере
# и Ctrl+C на локальной машине
```

### 13.4 Остановка с причиной `captcha` / `blocked` / `http-429`

Бот сам остановился и прислал диагностику. Порядок действий:

1. Проверить страницу вручную в браузере: там действительно проверка?
2. Если да — подождать, не делать запросов, затем `/resume`.
3. Снизить нагрузку: выключить лишние URL (`"enabled": false`), уменьшить
   `pagination.maxPagesPerUrl`, сузить окно опроса.
4. **Не** использовать прокси, смену IP, подмену заголовков — это вне согласованного доступа.

### 13.5 Задач приходит меньше, чем на сайте

```bash
journalctl -u kwork-bot | grep "заявлено"
```

Если видите `в выдаче заявлено 17, забрано 12` — увеличьте
`source.pagination.maxPagesPerUrl` (например, до 5) и перезапустите.

### 13.6 Сервер перезагрузился — что с ботом

Служба включена (`systemctl enable`), стартует автоматически. После перезапуска бот
выдерживает минимальный интервал с момента последнего запроса, чтобы не «долбить» Kwork:

```bash
journalctl -u kwork-bot | grep "Восстановлено время последнего запроса"
```

---

## 14. Чек-лист переноса

```
[ ] VPS создан, SSH по ключу, пароль отключён
[ ] ufw включён, открыт только SSH
[ ] Node.js ≥ 20.6 установлен (node -v)
[ ] Код доставлен в /opt/kwork-watcher/app (git clone или архив)
[ ] .env создан, chmod 600, токен и user id заполнены
[ ] config/default.json проверен: source.enabled, source.baseUrl, окно, интервал
[ ] node --test — все тесты зелёные
[ ] node src/index.js config-check --live — без ошибок
[ ] node src/index.js plan — URL и расписание прочитаны и совпадают с согласованными
[ ] Ручной запуск poll/bot — первый цикл отработал, сообщения пришли
[ ] systemd-юнит создан, enable --now выполнен, status — active (running)
[ ] journalctl показывает сводку цикла
[ ] Бэкап по cron настроен, восстановление проверено
[ ] Локальная копия бота остановлена (нет конфликта getUpdates)
[ ] .env и data/ не попали в git
```

---

## Приложение: типовые команды

```bash
# состояние
sudo systemctl status kwork-bot
node src/index.js status
node src/index.js categories

# диагностика
node src/index.js plan
node src/index.js config-check --live
node --test

# логи
journalctl -u kwork-bot -f
journalctl -u kwork-bot --since "today" | grep "Цикл завершён"

# обновление
cd /opt/kwork-watcher/app && sudo systemctl stop kwork-bot && git pull --ff-only \
  && node --test && sudo systemctl start kwork-bot

# бэкап вручную
/opt/kwork-watcher/backup.sh
```

## Приложение A: dashboard на VPS

`dashboard` — локальная страница состояния: план опроса, расписание, категории, профиль,
статистика хранилища и последние обработанные задания. Страница **только для чтения** и
**без пароля**, поэтому наружу её выставлять нельзя. Правильный способ — SSH-туннель.

### A.1 Запустить dashboard на сервере

`dashboard` — не служба, а одноразовая команда: пока процесс жив, страница доступна.

```bash
# на сервере, в отдельной сессии tmux/screen (чтобы не оборвалось при выходе из SSH)
tmux new -s dash
cd /opt/kwork-watcher/app
node src/index.js dashboard --port=8787
# Ctrl+B, затем D — отсоединиться, не убивая процесс
```

Если tmux не установлен: `sudo apt install -y tmux`.
Проверить, что слушает только localhost:

```bash
ss -ltnp | grep 8787        # должно быть 127.0.0.1:8787, а не 0.0.0.0:8787
```

### A.2 Открыть страницу у себя (SSH-туннель)

На **своей** машине:

```bash
ssh -N -L 8787:127.0.0.1:8787 kwork@<IP_СЕРВЕРА>
```

Команда ничего не выводит — это нормально, окно занято туннелем. Откройте в браузере:

```
http://127.0.0.1:8787
```

Важно: именно `127.0.0.1`, а не `<IP_СЕРВЕРА>`. Туннель перенаправляет локальный порт на
порт сервера. Пока туннель открыт, страница доступна; `Ctrl+C` закрывает доступ.

Полезные варианты:

```bash
# другой локальный порт, если 8787 занят
ssh -N -L 9000:127.0.0.1:8787 kwork@<IP>

# туннель в фоне (потом закрыть: kill %1 или pkill -f "ssh -N -L 8787")
ssh -f -N -L 8787:127.0.0.1:8787 kwork@<IP>
```

### A.3 Скрипт для регулярного просмотра

Если открываете дашборд часто, удобно одной командой поднимать его на сервере и сразу
пробрасывать порт. Файл `~/kwork-dashboard.sh` на **локальной** машине:

```bash
#!/usr/bin/env bash
# Открыть dashboard бота: поднимает его на сервере и открывает страницу локально.
set -euo pipefail
SERVER="${1:-kwork@<IP_СЕРВЕРА>}"
PORT="${2:-8787}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

say "Запускаю dashboard на сервере (порт $PORT)..."
ssh "$SERVER" "cd /opt/kwork-watcher/app && (pgrep -f 'index.js dashboard' >/dev/null && echo 'уже запущен') || (nohup node src/index.js dashboard --port=$PORT >/tmp/dashboard.log 2>&1 & sleep 1; echo 'запущен')"

say "Открываю туннель $PORT -> $SERVER:$PORT"
ssh -N -L "$PORT:127.0.0.1:$PORT" "$SERVER" &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT

sleep 1
URL="http://127.0.0.1:$PORT"
say "Открываю $URL (Ctrl+C закроет туннель)"
if command -v open >/dev/null; then open "$URL"        # macOS
elif command -v xdg-open >/dev/null; then xdg-open "$URL"   # Linux
else echo "Откройте вручную: $URL"; fi

wait $TUNNEL_PID
```

```bash
chmod +x ~/kwork-dashboard.sh
~/kwork-dashboard.sh                  # сервер по умолчанию
~/kwork-dashboard.sh kwork@1.2.3.4 9000
```

### A.4 Остановить dashboard

```bash
# на сервере
pkill -f "index.js dashboard"
# или, если запускали в tmux
tmux attach -t dash      # затем Ctrl+C
```

Не оставляйте dashboard работать постоянно: он держит состояние в памяти и не нужен боту
для опроса.

### A.5 Чего делать нельзя

```bash
# НЕЛЬЗЯ: страница без пароля, откроется всем в интернете
node src/index.js dashboard --host=0.0.0.0
```

Если так запустить, бот напишет в лог предупреждение:

```
[WARN] ВНИМАНИЕ: dashboard слушает 0.0.0.0 — он не защищён паролем и отдаёт состояние
бота, описания заданий и логи. Не открывайте его в интернет.
```

На странице видны заголовки заданий и последние обработанные записи — это данные заказчиков.
Доступ снаружи закрыт firewall (`ufw`), туннель — правильный путь.

### A.6 Дашборд на отдельном устройстве

Локальный порт можно не пробрасывать, а смотреть через `curl`, если нужен только JSON:

```bash
ssh kwork@<IP> "curl -s http://127.0.0.1:8787/api/state" | head -40
```
