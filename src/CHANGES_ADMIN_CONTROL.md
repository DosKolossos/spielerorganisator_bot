Änderungen in diesem Patch

- Adminrechte über Rolle `Schillok | Coaches` oder Discord-Adminrechte
- ADMIN_LOG_CHANNEL_ID wird für Admin-Aktionen genutzt
- Spieler können archiviert / wiederhergestellt werden
- Admins können Profile ansehen, bearbeiten, archivieren, wiederherstellen
- Admins können Abwesenheiten ansehen, erstellen, bearbeiten, löschen, genehmigen, ablehnen
- Eigene Abwesenheiten für heute sind nicht mehr erlaubt
- Eigene Abwesenheiten in der laufenden Woche landen als `pending_admin`
- Planner berücksichtigt `pending_admin`, ignoriert `rejected`
- Admins können Regeln ansehen, erstellen, bearbeiten, löschen, aussetzen, fortsetzen
- Regel-Aussetzungen werden im Planner und Verfügbarkeitscheck berücksichtigt
- Urlaub wird nicht mehr als Slash-Command registriert
- Archivierte Spieler tauchen nicht mehr im Reminder, Planner oder Select-Menüs auf
