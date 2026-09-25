# Fahrwasser

Seekarten-App auf Basis offener Daten. Sie läuft als statische Web-App, dazu kommt ein optionales AIS-Relay.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette App: Karte, Panels, Logik |
| `sw.js` | Service Worker: App offline, Kartenteile zwischengespeichert |
| `ais-relay-worker.js` | Cloudflare Worker, der AIS-Daten von aisstream.io holt |

## 1. App hosten

`index.html` und `sw.js` gehören in denselben Ordner, auf einen beliebigen statischen Host mit **HTTPS**. Geeignet sind z.B. GitHub Pages, Netlify oder Cloudflare Pages. GPS und Service Worker brauchen HTTPS.

Für einen lokalen Test: `npx serve .` im Ordner ausführen, danach `http://localhost:3000` öffnen.

## 2. AIS-Relay einrichten (optional)

aisstream.io erlaubt keine direkten Browser-Verbindungen. Deshalb braucht es ein kleines Relay.

1. Auf aisstream.io ein Konto anlegen und einen API-Key erzeugen.
2. Im Cloudflare-Dashboard unter **Workers & Pages** einen neuen Worker erstellen und den Inhalt von `ais-relay-worker.js` einfügen.
3. In den Worker-Einstellungen unter **Variablen** Folgendes hinterlegen:
   - Secret `AISSTREAM_API_KEY` mit deinem Key
   - optional `ALLOWED_ORIGIN` mit der Adresse deiner App, damit nur sie das Relay nutzen darf
4. Die Worker-Adresse in der App unter **Mehr › Info & Einstellungen** eintragen.

**Grenzen:**
- Das Relay sammelt pro Abruf etwa 8 Sekunden lang Meldungen. Schiffe, die in dieser Zeit senden, erscheinen sofort.
- Ankerlieger senden nur alle paar Minuten und tauchen deshalb erst nach einigen Abrufen auf. Die App behält die Schiffe 30 Minuten und stellt sie nach 10 Minuten grau dar.
- aisstream.io gibt keine Verfügbarkeitsgarantie. Die Abdeckung hängt von freiwilligen Empfangsstationen ab.

## Datenquellen

- Seekarte: Open Waters Seamap, CC BY 4.0, Daten © OpenStreetMap-Mitwirkende
- Wetter, Wellen, Wasserstand: Open-Meteo, CC BY 4.0
- Ortssuche: Nominatim, © OpenStreetMap-Mitwirkende
- AIS: aisstream.io
