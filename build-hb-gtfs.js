const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse'); // Změna: Už nepoužíváme /sync, ale streamovací verzi

const gtfsDir = './gtfs';
const outDir = './hb-timetables';

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

// Univerzální funkce pro čtení obřích CSV souborů po řádcích (bez ucpání RAM)
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
    console.log("1. Načítám zastávky...");
    const stopsMap = new Map();
    await processCsvLineByLine('stops.txt', (s) => {
        stopsMap.set(s.stop_id, s.stop_name);
    });

    console.log("2. Filtruji linky (CISJR:6050)...");
    const validRoutes = new Set();
    await processCsvLineByLine('routes.txt', (r) => {
        if (r.route_id.startsWith('CISJR:6050')) {
            validRoutes.add(r.route_id);
        }
    });

    console.log("3. Načítám spoje (Trips)...");
    const validTrips = new Map();
    await processCsvLineByLine('trips.txt', (t) => {
        if (validRoutes.has(t.route_id)) {
            // Získáme z CISJR:605002 pouze číslo 605002
            const vdvLine = t.route_id.replace('CISJR:', '');
            const runNumber = t.trip_short_name; 
            
            validTrips.set(t.trip_id, {
                line: vdvLine,
                run: runNumber,
                stops: []
            });
        }
    });

    console.log("4. Mapuji časy zastávek (Stop Times) přes paměťově šetrný Stream...");
    await processCsvLineByLine('stop_times.txt', (st) => {
        if (validTrips.has(st.trip_id)) {
            const trip = validTrips.get(st.trip_id);
            
            // Ořežeme sekundy
            const arrStr = st.arrival_time ? st.arrival_time.substring(0, 5) : "";
            const depStr = st.departure_time ? st.departure_time.substring(0, 5) : "";

            trip.stops.push({
                seq: parseInt(st.stop_sequence, 10),
                name: stopsMap.get(st.stop_id) || st.stop_id,
                arr: arrStr,
                dep: depStr
            });
        }
    });

    console.log("5. Generuji malé JSON soubory...");
    let generatedCount = 0;

    validTrips.forEach((trip) => {
        if (trip.stops.length > 0) {
            // Seřadíme zastávky logicky za sebou
            trip.stops.sort((a, b) => a.seq - b.seq);
            
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
