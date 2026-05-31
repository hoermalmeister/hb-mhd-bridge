const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// Render.com dynamicky přiděluje port
const PORT = process.env.PORT || 3000;

let hbVehicles = { type: "FeatureCollection", features: [] };

(async () => {
    console.log("Spouštím neviditelný prohlížeč pro Havlíčkův Brod...");
    
    // Konfigurace pro bezpečný běh v cloudovém prostředí
    const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();

    // Funkce, kterou zavolá Blazor stránka
    await page.exposeFunction('sendVehiclesToServer', (jsonString) => {
        try {
            const data = JSON.parse(jsonString);
            const features = [];
            
            data.forEach(v => {
                if (!v.position) return;
                const content = (v.tooltip && v.tooltip.content) ? v.tooltip.content : "";
                const linkaMatch = content.match(/Linka\s+(\d+)/i);
                const shortLine = linkaMatch ? linkaMatch[1] : "??";
                const finalStop = content.split('<br/>')[1] ? content.split('<br/>')[1].trim() : "";

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [v.position.lng, v.position.lat] },
                    properties: {
                        id: "HB-" + v.vehiclePlate.trim(),
                        delay: 0, 
                        traction: "BUS",
                        text: "Linka " + shortLine,
                        shortLine: shortLine,
                        finalStopName: finalStop,
                        isJihlava: false,
                        isTrain: false,
                        isNonVDV: false
                    }
                });
            });

            hbVehicles.features = features;
            console.log(`[HB] Aktualizováno vozidel: ${features.length}`);
        } catch (e) {
            console.error("Chyba zpracování:", e);
        }
    });

    // Injekce odposlouchávače
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(window, 'MapLeafletInterop', {
            configurable: true,
            enumerable: true,
            get() { return this._interop; },
            set(val) {
                if (val && val.updateBusMarker) {
                    const originalUpdate = val.updateBusMarker;
                    val.updateBusMarker = function(data) {
                        window.sendVehiclesToServer(JSON.stringify(data));
                        return originalUpdate.apply(this, arguments);
                    };
                }
                this._interop = val;
            }
        });
    });

    // Otevřeme stránku a držíme ji otevřenou
    await page.goto('https://www.mhdhb.cz/', { waitUntil: 'networkidle0' });
    console.log("MHD HB načteno. Odposlouchávám data...");
})();

// Vystavíme JSON pro tvůj frontend
app.get('/hb.geojson', (req, res) => {
    res.json(hbVehicles);
});

// Spuštění API
app.listen(PORT, () => {
    console.log(`✅ Havlíčkův Brod Bridge API běží na portu ${PORT}`);
});