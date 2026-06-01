const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse'); 

const gtfsDir = './gtfs';
const outDir = './hb-timetables';

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

// Paměťově šetrný parser pro velké soubory
function processCsvLineByLine(filename, onRecord) {
    return new Promise((resolve, reject) => {
        const filepath = path.join(gtfsDir, filename);
        if (!fs.existsSync(filepath)) {
            console.warn(`⚠️ Soubor ${filename} neexistuje, přeskakuji.`);
            return resolve();
        }
        
        const parser = parse({ columns: true, skip_empty_lines: true });
        
        parser.on('readable', function() {
            let record;
            while ((record = parser.read()) !== null) {
                onRecord(record);
            }
        });
        
        parser.on('error', function(err) {
            reject(err);
        });
        
        parser.on('end', function() {
            resolve();
        });
        
        fs.createReadStream(filepath).pipe(parser);
    });
}

async function main() {
    console.log("1. Načítám zastávky a jejich GPS souřadnice...");
    const stopsMap = new Map();
    await processCsvLineByLine('stops.txt', (s) => {
        // Ukládáme komplexní objekt s názvem a souřadnicemi
        stopsMap.set(s.stop_id, {
            name: s.stop_name,
            lat: parseFloat(s.stop_lat),
            lon: parseFloat(s.stop_lon)
        });
    });

    console.log("2. Filtruji linky (CISJR:6050)...");
    const validRoutes = new Set();
    await processCsvLineByLine('routes.txt', (r) => {
        if (r.route_id.startsWith('CISJR:6050')) {
            validRoutes.add(r.route_id);
        }
    });

    console.log("3. Načítám spoje (Trips) přes precizní parsování trip_id...");
    const validTrips = new Map();
    await processCsvLineByLine('trips.txt', (t) => {
        if (validRoutes.has(t.route_id)) {
            // trip_id je ve formátu: 2025-12-14_2026-12-12.CISJR:605003.9fbd4750.CISJR:11
            // Regulární výraz najde dvě čísla po řetězcích "CISJR:"
            const match = t.trip_id.match(/CISJR:(\d+)\..*\.CISJR:(\d+)/);
            
            if (match) {
                const vdvLine = match[1]; // např. "605003"
                const runNumber = match[2]; // např. "11"
                
                validTrips.set(t.trip_id, {
                    line: vdvLine,
                    run: runNumber,
                    stops: []
                });
            }
        }
    });

    console.log("4. Mapuji časy a souřadnice zastávek (Stop Times)...");
    await processCsvLineByLine('stop_times.txt', (st) => {
        if (validTrips.has(st.trip_id)) {
            const trip = validTrips.get(st.trip_id);
            const stopInfo = stopsMap.get(st.stop_id);
            
            // Ořežeme vteřiny (z 08:35:00 na 08:35)
            const arrStr = st.arrival_time ? st.arrival_time.substring(0, 5) : "";
            const depStr = st.departure_time ? st.departure_time.substring(0, 5) : "";

            trip.stops.push({
                seq: parseInt(st.stop_sequence, 10),
                name: stopInfo ? stopInfo.name : st.stop_id,
                lat: stopInfo ? stopInfo.lat : null,
                lon: stopInfo ? stopInfo.lon : null,
                arr: arrStr,
                dep: depStr
            });
        }
    });

    console.log("5. Generuji malé JSON soubory...");
    let generatedCount = 0;

    validTrips.forEach((trip) => {
        if (trip.stops.length > 0) {
            // Seřadíme zastávky logicky podle pořadí na trase
            trip.stops.sort((a, b) => a.seq - b.seq);
            
            // Pojmenování: 605003_11.json
            const fileName = `${trip.line}_${trip.run}.json`;
            
            fs.writeFileSync(
                path.join(outDir, fileName), 
                JSON.stringify(trip.stops, null, 2)
            );
            generatedCount++;
        }
    });

    console.log(`✅ Úspěch! Vygenerováno ${generatedCount} jízdních řádů pro Havlíčkův Brod.`);
}

main().catch(err => {
    console.error("❌ Kritická chyba:", err);
    process.exit(1);
});
