const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Paměť pro data
const vehicleMap = new Map(); 
let latestTableData = [];     
let hbVehicles = { type: "FeatureCollection", features: [] };

(async () => {
    console.log("🚀 Spouštím neviditelný prohlížeč pro Havlíčkův Brod...");
    
    const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();

    // Propíšeme konzoli z neviditelného prohlížeče
    page.on('console', msg => console.log(`[PROHLÍŽEČ]: ${msg.text()}`));

    // 1. Zpracování GPS pozic (s časovým razítkem)
    await page.exposeFunction('sendVehiclesToServer', (jsonString) => {
        try {
            const args = JSON.parse(jsonString);

            const extractVehicles = (obj) => {
                if (!obj) return;
                if (Array.isArray(obj)) {
                    obj.forEach(extractVehicles);
                } else if (typeof obj === 'object') {
                    if (obj.vehiclePlate && obj.position && obj.position.lat && obj.position.lng) {
                        const spz = obj.vehiclePlate.trim();
                        const content = (obj.tooltip && obj.tooltip.content) ? obj.tooltip.content : "";
                        
                        const linkaMatch = content.match(/Linka\s+(\d+)/i);
                        const spojMatch = content.match(/\((\d+)\)/);
                        
                        const shortLine = linkaMatch ? linkaMatch[1] : "??";
                        const runNumber = spojMatch ? spojMatch[1] : "";
                        const finalStop = content.split('<br/>')[1] ? content.split('<br/>')[1].trim() : "";
                        const angle = obj.angle || 0; 

                        let vdvLine = "";
                        if (shortLine !== "??") {
                            vdvLine = (605000 + parseInt(shortLine, 10)).toString();
                        }

                        // Uložení základu z mapy + ČASOVÉ RAZÍTKO
                        vehicleMap.set(spz, {
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [obj.position.lng, obj.position.lat] },
                            properties: {
                                id: "HB-" + spz,
                                vehiclePlate: spz,
                                angle: angle,
                                text: "Linka " + shortLine,
                                shortLine: shortLine,
                                runNumber: runNumber,
                                vdvLine: vdvLine,
                                finalStopName: finalStop,
                                isHBrod: true,
                                isTrain: false,
                                isNonVDV: true,
                                delay: 0,
                                lastStop: "",
                                delayClass: 'dim',
                                lastSeen: Date.now() // <--- ZÁZNAM ČASU POSLEDNÍ AKTUALIZACE
                            }
                        });
                    } else {
                        Object.values(obj).forEach(extractVehicles);
                    }
                }
            };

            extractVehicles(args);
            buildFinalGeoJson();

        } catch (e) {
            console.error("❌ Chyba zpracování dat z mapy:", e);
        }
    });

    // 2. Zpracování tabulky zpoždění a zastávek
    await page.exposeFunction('sendTableToServer', (jsonString) => {
        try {
            latestTableData = JSON.parse(jsonString);
            buildFinalGeoJson();
        } catch (e) {
            console.error("❌ Chyba zpracování dat z tabulky:", e);
        }
    });

    // 3. Fúze dat (Spojí GPS + Tabulku)
    function buildFinalGeoJson() {
        const features = Array.from(vehicleMap.values());

        features.forEach(f => {
            const props = f.properties;
            
            const tableMatch = latestTableData.find(t => 
                t.line === props.shortLine && 
                t.direction.toLowerCase() === props.finalStopName.toLowerCase()
            );

            if (tableMatch) {
                props.delay = tableMatch.delay;
                props.lastStop = tableMatch.currentStop;
                
                if (props.delay >= 10) props.delayClass = 'alert';
                else if (props.delay > 2) props.delayClass = 'warn';
                else props.delayClass = 'ok';
            }
        });

        hbVehicles.features = features;
    }

    // --- AUTOMATICKÝ ÚKLID (GARBAGE COLLECTOR) ---
    // Každých 60 vteřin zkontrolujeme, zda nějaký autobus "neumřel"
    setInterval(() => {
        const now = Date.now();
        let removedCount = 0;

        for (const [spz, vehicle] of vehicleMap.entries()) {
            // Pokud jsme o autobusu neslyšeli déle než 3 minuty (180 000 milisekund), smažeme ho
            if (now - vehicle.properties.lastSeen > 180000) {
                vehicleMap.delete(spz);
                removedCount++;
                console.log(`🧹 Úklid: Smazán neaktivní autobus ${spz}`);
            }
        }

        // Pokud jsme něco smazali, přegenerujeme finální JSON
        if (removedCount > 0) {
            buildFinalGeoJson();
        }
    }, 60000);

    // 4. Injekce kódů do stránky
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
                                    window.sendVehiclesToServer(JSON.stringify(Array.from(arguments)));
                                }
                                return originalFn.apply(this, arguments);
                            };
                        }
                    }
                }
                interopCache = val;
            }
        });

        // Tabulkový Scraper
        setInterval(() => {
            const rows = document.querySelectorAll('tr.dxbs-data-row');
            const tableData = [];
            
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 6) {
                    const delayText = cells[5].innerText.trim();
                    const delayVal = parseInt(delayText, 10);
                    
                    tableData.push({
                        line: cells[0].innerText.trim(),
                        direction: cells[1].innerText.trim(),
                        currentStop: cells[2].innerText.trim(),
                        delay: isNaN(delayVal) ? 0 : delayVal
                    });
                }
            });

            if (tableData.length > 0 && window.sendTableToServer) {
                window.sendTableToServer(JSON.stringify(tableData));
            }
        }, 2000);
    });

    console.log("⏳ Přistupuji na www.mhdhb.cz...");
    await page.goto('https://www.mhdhb.cz/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log("✅ MHD HB načteno. Systém je plně v provozu!");

})();

// KONTROLNÍ PANEL PRO HLAVNÍ STRÁNKU
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
            <h1>🚌 Fúzní Most pro MHD Havlíčkův Brod</h1>
            <p style="font-size: 20px;">Aktivních autobusů (poslední 3 minuty): <b style="color: #27ae60; font-size: 24px;">${vehicleMap.size}</b></p>
            <p style="font-size: 20px;">Zachyceno dat v tabulce: <b style="color: #8e44ad; font-size: 24px;">${latestTableData.length}</b> řádků</p>
            <a href="/hb.geojson" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #2980b9; color: white; text-decoration: none; border-radius: 5px;">Zobrazit GeoJSON Data</a>
        </div>
    `);
});

// API Endpoint pro tvoji mapu
app.get('/hb.geojson', (req, res) => {
    // Před odesláním můžeme vyfiltrovat lastSeen, aby data byla menší, ale Leafletu to vůbec nevadí, takže rovnou posíláme
    res.json(hbVehicles);
});

app.listen(PORT, () => {
    console.log(`✅ Havlíčkův Brod Bridge API běží na portu ${PORT}`);
});
