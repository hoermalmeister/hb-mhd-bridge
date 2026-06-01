const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const gtfsDir = './gtfs';
const outDir = './hb-timetables';

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir);
}

console.log("1. Načítám zastávky...");
const stopsCsv = parse(fs.readFileSync(path.join(gtfsDir, 'stops.txt')), { columns: true });
const stopsMap = new Map();
stopsCsv.forEach(s => stopsMap.set(s.stop_id, s.stop_name));

console.log("2. Filtruji linky (CISJR:6050)...");
const routesCsv = parse(fs.readFileSync(path.join(gtfsDir, 'routes.txt')), { columns: true });
const validRoutes = new Set();
routesCsv.forEach(r => {
    if (r.route_id.startsWith('CISJR:6050')) {
        validRoutes.add(r.route_id);
    }
});

console.log("3. Načítám spoje (Trips)...");
const tripsCsv = parse(fs.readFileSync(path.join(gtfsDir, 'trips.txt')), { columns: true });
const validTrips = new Map(); // trip_id -> { line, run, stops: [] }

tripsCsv.forEach(t => {
    if (validRoutes.has(t.route_id)) {
        // Získáme z CISJR:605002 pouze číslo 605002
        const vdvLine = t.route_id.replace('CISJR:', '');
        // Číslo spoje je v trip_short_name
        const runNumber = t.trip_short_name; 
        
        validTrips.set(t.trip_id, {
            line: vdvLine,
            run: runNumber,
            stops: []
        });
    }
});

console.log("4. Mapuji časy zastávek (Stop Times)...");
const stopTimesCsv = parse(fs.readFileSync(path.join(gtfsDir, 'stop_times.txt')), { columns: true });
stopTimesCsv.forEach(st => {
    if (validTrips.has(st.trip_id)) {
        const trip = validTrips.get(st.trip_id);
        
        // Převedeme časy na čistší formát (odstraníme vteřiny: 08:35:00 -> 08:35)
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

console.log("5. Generuji JSON soubory...");
let generatedCount = 0;

validTrips.forEach((trip) => {
    if (trip.stops.length > 0) {
        // Seřadíme zastávky podle pořadí na trase
        trip.stops.sort((a, b) => a.seq - b.seq);
        
        // Vytvoříme soubor, např. 605002_723.json
        const fileName = `${trip.line}_${trip.run}.json`;
        
        fs.writeFileSync(
            path.join(outDir, fileName), 
            JSON.stringify(trip.stops, null, 2)
        );
        generatedCount++;
    }
});

console.log(`✅ Hotovo! Vygenerováno ${generatedCount} jízdních řádů pro Havlíčkův Brod.`);
