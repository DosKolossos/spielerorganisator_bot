# Planner-Web: sichere Read-only-Vorschau

Die erste Webversion zeigt beide aktiven Teams, kommende Termine, Aufstellungen,
Verfügbarkeiten und Entweder-oder-Angaben. Änderungen an Discord oder der Datenbank
sind über die Webseite noch nicht möglich.

## Betrieb

Standardmäßig lauscht der Server ausschließlich lokal:

```text
http://127.0.0.1:3100
```

Optionale Umgebungsvariablen:

- `PLANNER_WEB_ENABLED=false` deaktiviert die Webvorschau.
- `PLANNER_WEB_HOST` ändert die Bind-Adresse. Bis zur Authentifizierung bei
  `127.0.0.1` belassen.
- `PLANNER_WEB_PORT` ändert den Port, Standard ist `3100`.

Gesundheitsprüfung:

```bash
curl --fail http://127.0.0.1:3100/healthz
```

Die öffentliche Subdomain wird erst nach Discord-Authentifizierung über einen
HTTPS-Reverse-Proxy auf diesen lokalen Port weitergeleitet.
