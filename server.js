const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Paměť pro autobusy (Klíč: SPZ, Hodnota: GeoJSON Feature)
const vehicleMap = new Map();
let hbVehicles = { type: "FeatureCollection", features: [] };

(async () => {
    console.log("Spouštím neviditelný prohlížeč pro Havlíčkův Brod...");
    
    const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();

    // Funkce, kterou zavolá odposlouchávač ze stránky
    await page.exposeFunction('sendVehiclesToServer', (jsonString) => {
        try {
            const args = JSON.parse(jsonString);

            // Pomocná funkce: prohledá všechna data od Blazoru a najde cokoliv, co vypadá jako autobus
            const extractVehicles = (obj) => {
                if (!obj) return;
                if (Array.isArray(obj)) {
                    obj.forEach(extractVehicles);
                } else if (typeof obj === 'object') {
                    // Je to autobus? (Má to SPZ a pozici?)
                    if (obj.vehiclePlate && obj.position && obj.position.lat && obj.position.lng) {
                        const spz = obj.vehiclePlate.trim();
                        const content = (obj.tooltip && obj.tooltip.content) ? obj.tooltip.content : "";
                        const linkaMatch = content.match(/Linka\s+(\d+)/i);
                        const shortLine = linkaMatch ? linkaMatch[1] : "??";
                        const finalStop = content.split('<br/>')[1] ? content.split('<br/>')[1].trim() : "";

                        // Uložíme / Aktualizujeme autobus v paměti podle jeho SPZ
                        vehicleMap.set(spz, {
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [obj.position.lng, obj.position.lat] },
                            properties: {
                                id: "HB-" + spz,
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
                    } else {
                        Object.values(obj).forEach(extractVehicles);
                    }
                }
            };

            // Spustíme hledání v přijatých datech
            extractVehicles(args);

            // Aktualizujeme finální GeoJSON, který si stahuje tvoje mapa
            hbVehicles.features = Array.from(vehicleMap.values());
            console.log(`[HB] Nová data! Celkem autobusů v paměti: ${hbVehicles.features.length}`);

        } catch (e) {
            console.error("Chyba zpracování:", e);
        }
    });

    // Injekce odposlouchávače pro obě funkce (addBusMarker i updateBusMarker)
    await page.evaluateOnNewDocument(() => {
        let interopCache = {};
        Object.defineProperty(window, 'MapLeafletInterop', {
            configurable: true,
            enumerable: true,
            get() { return interopCache; },
            set(val) {
                if (val) {
                    // Zachycení úvodního přidání autobusů
                    if (val.addBusMarker) {
                        const originalAdd = val.addBusMarker;
                        val.addBusMarker = function() {
                            if (window.sendVehiclesToServer) window.sendVehiclesToServer(JSON.stringify(Array.from(arguments)));
                            return originalAdd.apply(this, arguments);
                        };
                    }
                    // Zachycení pohybu autobusů
                    if (val.updateBusMarker) {
                        const originalUpdate = val.updateBusMarker;
                        val.updateBusMarker = function() {
                            if (window.sendVehiclesToServer) window.sendVehiclesToServer(JSON.stringify(Array.from(arguments)));
                            return originalUpdate.apply(this, arguments);
                        };
                    }
                }
                interopCache = val;
            }
        });
    });

    await page.goto('https://www.mhdhb.cz/', { waitUntil: 'networkidle0' });
    console.log("MHD HB načteno. Čekám na data od Blazoru...");
})();

// API Endpoint pro tvoji mapu
app.get('/hb.geojson', (req, res) => {
    res.json(hbVehicles);
});

app.listen(PORT, () => {
    console.log(`✅ Havlíčkův Brod Bridge API běží na portu ${PORT}`);
});
