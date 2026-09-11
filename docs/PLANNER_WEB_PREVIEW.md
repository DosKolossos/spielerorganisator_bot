# Planner-Web

Der geschützte Webplaner zeigt Mainteam und Shinys in einer horizontalen
Wochenansicht. Er verwendet dieselbe SQLite-Datenbank wie der Discord-Bot; die
Oberfläche erhält Änderungen alle drei Sekunden per Server-Sent Events.

## Funktionen

- Wochenwechsel und freie Wochenauswahl
- Teamtermine Montag bis Sonntag; Ergebnisse vergangener Termine
- vollständiges Main-Line-up pro Tag auf einen Blick
- ein-/ausklappbare Spieler- und Sub-Ansicht; einzelne Spieler lokal ausblendbar
- Terminbearbeitung mit Zustand `Vorgeplant`
- Format `2 Spiele`, `3 Spiele`, `BO3`, `BO4` oder `BO5`
- Fearless oder normaler Draft
- Gegner-OP.GG, Gegneraufstellung, Ergebnis und Drafter-Link
- dringende Aufgaben erst ab dem Kalendertag vor dem Termin
- Warnungen bei Verfügbarkeitsänderungen nach Sonntag 20:00 Uhr
- Export-Vorschau, Abgleich mit den Discord-Schedule-Karten und Rückgängig
- Konflikt- und Matchday-Ansicht
- sichere Kopie der Terminstruktur aus der Vorwoche
- automatische Übernahme eindeutiger Gegnerrollen, wenn das Gegner-Archiv sie
  mit ausreichender Sicherheit zurückliefert; unklare Rollen bleiben sichtbar offen

Beim Export werden ausschließlich die vom Spielerorganisator gespeicherten
Schedule-Karten erstellt, aktualisiert oder entfernt. Andere Discord-Nachrichten
bleiben unangetastet. Nach Ablauf eines Termins wird weiterhin nur die Admin-Karte
automatisch gelöscht.

## Betrieb

Der Server lauscht standardmäßig lokal auf `http://127.0.0.1:3100`.

- `PLANNER_WEB_ENABLED=false` deaktiviert ihn.
- `PLANNER_WEB_HOST` ändert die Bind-Adresse.
- `PLANNER_WEB_PORT` ändert den Port.

Gesundheitsprüfung:

```bash
curl --fail http://127.0.0.1:3100/healthz
```

## Discord-Anmeldung

Benötigt werden:

- `DISCORD_CLIENT_SECRET`
- `PLANNER_SESSION_SECRET` (zufälliger Wert mit mindestens 32 Byte)
- `PLANNER_PUBLIC_URL=https://planner.schiggygang.de`

OAuth2-Weiterleitungsadresse:

```text
https://planner.schiggygang.de/auth/callback
```

Die Anmeldung fordert nur `identify` und `guilds.members.read` an. Zugriff haben
Serverbesitzer, Server-Administratoren und Mitglieder mit der Rolle
`Schillok | Coaches` (über `ADMIN_ROLE_NAME` änderbar).

## Drafter.lol

Die manuelle Speicherung und das Kopieren eines Drafter-Links funktionieren ohne
weitere Konfiguration. Für „Neu generieren“ muss der auf der Drafter.lol-Seite
erzeugte API-Token ausschließlich auf dem Server hinterlegt werden:

```text
DRAFTER_API_TOKEN=...
```

Optional:

```text
DRAFTER_API_URL=https://api.drafter.lol/api/series
DRAFTER_HOME_TEAM_NAME=SchiggyGang
```

Der Token gehört weder ins Repository noch in Discord. Für Prime-League-Termine
wird absichtlich kein Drafter erzeugt oder verlangt; die Oberfläche zeigt ihn als
externen Punkt an. Gegner-OP.GG, Gegneraufstellung und Ergebnis werden bei PRM erst
nach dem Termin als Archiv-Nacharbeit angeboten.
