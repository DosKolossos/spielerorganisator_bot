# Multi-Team-Setup

Diese Version legt beim ersten Start automatisch ein Standardteam an und ordnet bestehende Spieler, Termine und Wochenkarten diesem Team zu. Bestehende Einträge werden nicht gelöscht.

## 1. Deployment

```bash
git add src/db/database.js src/index.js src/utils/playerUtils.js src/services/teamService.js src/services/weeklyAvailabilityService.js src/commands/team.js src/commands/verfuegbarkeit.js src/commands/spieltermin.js MULTI_TEAM_SETUP.md
git commit -m "Add multi-team foundation"
git push
```

Auf dem Server:

```bash
cd /opt/spielerorganisator/app
git pull
pm2 restart spielerorganisator --update-env
pm2 logs spielerorganisator --lines 100
```

## 2. Bestehendes Team prüfen

Nach dem Neustart:

```text
/team liste
```

Das automatisch migrierte Standardteam übernimmt – sofern in `.env` vorhanden – diese alten Werte:

- `ADMIN_CHANNEL_ID`
- `WEEKLY_AVAILABILITY_CHANNEL_ID`
- `PLAYER_CALENDAR_CHANNEL_ID`

## 3. Zweites Team erstellen

```text
/team erstellen
```

Dabei werden Name, Kürzel, Teamrolle, Adminkanal, Wochenkarten-Kanal und Spielerkalender-Kanal gewählt. Scrim- und Prime-League-Kanal sind optional.

## 4. Spieler zuordnen

```text
/team spieler-zuweisen spieler:@Name team:<Team>
```

Der Spieler muss bereits ein Profil besitzen.

## 5. Verwendung

- `/verfuegbarkeit wochenkarten` immer im Adminkanal des gewünschten Teams ausführen.
- Neue `/spieltermin erstellen`-Einträge erhalten das Team des Kanals, in dem der Befehl ausgeführt wird.
- Der Button „Spielerkalender“ spiegelt in den für dieses Team konfigurierten Spielerkalender-Kanal.
- Bestehende Termine bleiben dem automatisch angelegten Standardteam zugeordnet.

## Hinweis

Die Team-Auswahlwerte der Slash-Commands werden beim Botstart registriert. Nach dem Anlegen eines Teams den Bot einmal neu starten, damit das neue Team auch in allen Auswahlfeldern erscheint.
