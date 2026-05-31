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
    console.log("🚀 Spouštím neviditelný prohlížeč pro Havlíčkův Brod...");
    
    const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();

    // Propíšeme konzoli z neviditelného prohlížeče k nám do logů (super pro ladění)
    page.on('console', msg => console.log(`[PROHLÍŽEČ]: ${msg.text()}`));

    // Funkce, kterou zavolá odposlouchávač ze stránky
    await page.exposeFunction('sendVehiclesToServer', (jsonString, functionName) => {
        try {
            console.log(`[ODPOSLECH] Zachyceno volání: ${functionName}`);
            const args = JSON.parse(jsonString);

            // Rekurzivní prohledávač JSONu
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
                                isNonVDV: false,
                                delayClass: 'ok'
                            }
                        });
                        console.log(`🚌 Nalezen/Aktualizován autobus: ${spz} (Linka ${shortLine})`);
                    } else {
                        Object.values(obj).forEach(extractVehicles);
                    }
                }
            };

            extractVehicles(args);

            hbVehicles.features = Array.from(vehicleMap.values());
        } catch (e) {
            console.error("❌ Chyba zpracování dat ze stránky:", e);
        }
    });

    // Univerzální injekce odposlouchávače (Napíchne VŠECHNY funkce obsahující marker/bus)
    await page.evaluateOnNewDocument(() => {
        let interopCache = {};
        Object.defineProperty(window, 'MapLeafletInterop', {
            configurable: true,
            enumerable: true,
            get() { return interopCache; },
            set(val) {
                if (val) {
                    for (const key of Object.keys(val)) {
                        if (typeof val[key] === 'function' && key.toLowerCase().includes('marker')) {
                            const originalFn = val[key];
                            val[key] = function() {
                                if (window.sendVehiclesToServer) {
                                    // Pošleme data ven i s názvem zachycené funkce
                                    window.sendVehiclesToServer(JSON.stringify(Array.from(arguments)), key);
                                }
                                return originalFn.apply(this, arguments);
                            };
                        }
                    }
                }
                interopCache = val;
            }
        });
    });

    // Přejdeme na stránku, nečekáme na absolutní klid sítě, jen na DOM
    console.log("⏳ Přistupuji na www.mhdhb.cz...");
    await page.goto('https://www.mhdhb.cz/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log("✅ MHD HB načteno. Naslouchám Blazoru...");

})();

// --- WEBOVÝ SERVER (API) ---

// KONTROLNÍ PANEL PRO HLAVNÍ STRÁNKU (Aby to neházelo Cannot GET /)
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
            <h1>🚌 Most pro MHD Havlíčkův Brod</h1>
            <p style="font-size: 20px;">Aktuálně uloženo v paměti: <b style="color: #27ae60; font-size: 24px;">${hbVehicles.features.length}</b> vozidel</p>
            <a href="/hb.geojson" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #2980b9; color: white; text-decoration: none; border-radius: 5px;">Zobrazit GeoJSON Data</a>
        </div>
    `);
});

// API Endpoint pro tvoji mapu
app.get('/hb.geojson', (req, res) => {
    res.json(hbVehicles);
});

app.listen(PORT, () => {
    console.log(`✅ Havlíčkův Brod Bridge API běží na portu ${PORT}`);
});
