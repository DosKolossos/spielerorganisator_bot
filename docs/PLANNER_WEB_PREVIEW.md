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

## Discord-Anmeldung

Vor der öffentlichen Freigabe werden folgende Umgebungsvariablen benötigt:

- `DISCORD_CLIENT_SECRET`: Client Secret der vorhandenen Discord-Anwendung
- `PLANNER_SESSION_SECRET`: zufälliger geheimer Wert mit mindestens 32 Byte
- `PLANNER_PUBLIC_URL=https://planner.schiggygang.de`

Als OAuth2-Weiterleitungsadresse muss in Discord exakt diese Adresse eingetragen sein:

```text
https://planner.schiggygang.de/auth/callback
```

Die Anmeldung fordert ausschließlich `identify` und `guilds.members.read` an.
Zugriff erhalten der Serverbesitzer, Benutzer mit Administrator- oder
Server-verwalten-Recht sowie Mitglieder mit der konfigurierten Admin-Rolle
(standardmäßig `Schillok | Coaches`). Erst danach wird der HTTPS-Reverse-Proxy
auf den lokalen Port weitergeleitet.
