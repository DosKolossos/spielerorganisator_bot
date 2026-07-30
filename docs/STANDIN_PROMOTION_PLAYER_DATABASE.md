# Standin-Beförderung und Spielerdatenbank

## Standin zum Roster-Mitglied befördern

Mit `/standin befoerdern` wird ein bestehender Standin in ein reguläres Spielerprofil überführt.

Benötigt werden:

- `id`: Standin-ID aus `/standin list`
- `spieler`: der zugehörige Discord-Nutzer

Optional können Team, Roster-Status, Hauptposition und Nebenposition festgelegt werden. Ohne Angabe wird der Spieler als Sub übernommen; als Hauptposition wird die bisherige Standin-Position verwendet.

Bei der Beförderung werden:

- Riot-ID, Region, Name und Position übernommen,
- ein vorhandenes Spielerprofil aktualisiert oder ein neues angelegt,
- archivierte Spielerprofile wieder aktiviert,
- alle bisherigen Aufstellungen des Standins auf die neue Spieler-ID umgestellt,
- betroffene Admin- und Spielerkarten synchronisiert,
- der Standin als „Befördert“ markiert und nicht gelöscht.

Ein bereits beförderter Standin kann nicht erneut als Standin aktiviert werden. Dadurch entstehen keine doppelten Einträge.

## Alle Spieler aus der Datenbank anzeigen

`/profil admin-liste` zeigt aktive und archivierte Spielerprofile an. Die Liste enthält:

- feste Datenbank-ID,
- Discord-Nutzer und Discord-ID,
- Team,
- Roster-Status,
- Haupt- und Nebenposition,
- Riot-ID und Region,
- Archivstatus.

Die Liste kann nach Team, Roster-Status und Archivstatus gefiltert werden. Pro Seite werden zehn Spieler angezeigt; weitere Seiten werden mit der Option `seite` geöffnet.

Mit `/profil admin-anzeigen-id id:<ID>` kann ein einzelnes Profil anschließend direkt über seine Datenbank-ID angezeigt werden.
