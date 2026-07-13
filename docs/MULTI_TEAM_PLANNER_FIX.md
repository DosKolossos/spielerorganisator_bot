# Multi-Team Planner Fix

## Geändert

- `/admin test-planner` ermittelt das Team anhand des aktuellen Kanals.
- Das Planner-Modal bestätigt die Discord-Interaktion sofort (`deferReply`), damit keine `Unknown interaction`-Fehler mehr entstehen.
- Spieler, Abwesenheiten und Regeln werden nach `team_id` gefiltert.
- Automatisch erzeugte Terminoptionen erhalten eine teamspezifische `suggestion_key` und `team_id`.
- Manuelle und automatische Termine werden in der Adminansicht nach Team gefiltert.
- Alte Karten werden nur noch für das jeweilige Team bereinigt.
- Der Ziel-Adminkanal wird aus der Teamkonfiguration geladen.
- Aufstellungs-Dropdowns zeigen nur Spieler des Teams des Termins; Standins bleiben teamübergreifend.
- Der automatische Sonntags-Planer läuft nacheinander für alle aktiven Teams.

## Hinweis zu bereits geposteten falschen Karten

Discord-Nachrichten, die vor diesem Fix im falschen Adminkanal gepostet wurden, können manuell gelöscht werden. Die zugrunde liegenden Spieler und Verfügbarkeiten müssen nicht gelöscht werden.
