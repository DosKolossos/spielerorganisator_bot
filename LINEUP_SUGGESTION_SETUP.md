# Automatische Line-up-Vorschläge

Beim Klick auf **Aufstellung** wird für einen noch leeren Termin automatisch ein Vorschlag aus den verfügbaren Spielern des jeweiligen Teams erzeugt.

Priorität:
1. Spieler ist für das Terminfenster verfügbar.
2. Hauptposition passt.
3. Nebenposition passt.
4. Fill passt.
5. Main-Line-up vor Sub.
6. Ein Spieler wird nur einmal eingesetzt.

Für jede Starterposition erscheint ein eigenes Dropdown. Fehlt eine Position, steht dort **Ersatz besorgen**. Darüber lassen sich Subs und aktive Standins auswählen. Über **Neuen Standin anlegen** kann ein neuer Standin mit Riot-ID direkt gespeichert und der offenen Position zugewiesen werden.

Bestehende Aufstellungen werden beim erneuten Öffnen nicht überschrieben. Der automatische Vorschlag läuft nur, wenn noch keine Starterposition gesetzt ist.
