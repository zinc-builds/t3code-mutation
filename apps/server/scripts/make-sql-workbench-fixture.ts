#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - A plain Node fixture writer, not server code.

/**
 * Writes the sample data the `sql-workbench` template is tested with: a bike
 * share database (`trips.sqlite`: cities, stations, bike types, riders, trips
 * and a `trip_facts` view) and a daily `weather.csv` from "another source",
 * which the template imports as a table to join against.
 *
 *   node apps/server/scripts/make-sql-workbench-fixture.ts [outDir] [--trips N]
 *
 * outDir defaults to the shipped-template fixture the server tests publish
 * with; --trips defaults to 1500, which keeps it near 200 KB. The data is
 * deterministic (seeded), shaped like the kit's trips.csv sample: four cities,
 * 24 stations, April to September 2026.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

const args = process.argv.slice(2);
const tripsFlag = args.indexOf("--trips");
const tripCount = tripsFlag === -1 ? 1500 : Number(args[tripsFlag + 1]);
if (!Number.isInteger(tripCount) || tripCount < 1)
  throw new Error("--trips needs a positive integer.");
const target = args.find(
  (_, index) => tripsFlag === -1 || (index !== tripsFlag && index !== tripsFlag + 1),
);
const outDir = NodePath.resolve(
  target ??
    NodeURL.fileURLToPath(
      new URL(
        "../src/mutationWorkspace/__fixtures__/shipped-templates/sql-workbench",
        import.meta.url,
      ),
    ),
);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(42);
const between = (min: number, max: number) => min + random() * (max - min);
const pick = <T>(items: ReadonlyArray<readonly [T, number]>): T => {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let at = random() * total;
  for (const [item, weight] of items) {
    at -= weight;
    if (at <= 0) return item;
  }
  return items[items.length - 1]![0];
};
const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
const round = (value: number, digits: number) => Number(value.toFixed(digits));
const pad = (value: number) => String(value).padStart(2, "0");
const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${day(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

const CITIES = [
  {
    name: "Austin",
    country: "US",
    timezone: "America/Chicago",
    launched: "2024-03-01",
    lat: 30.27,
    lon: -97.74,
    temp: 29,
    rain: 0.18,
  },
  {
    name: "Berlin",
    country: "DE",
    timezone: "Europe/Berlin",
    launched: "2023-05-15",
    lat: 52.52,
    lon: 13.4,
    temp: 18,
    rain: 0.32,
  },
  {
    name: "Lisbon",
    country: "PT",
    timezone: "Europe/Lisbon",
    launched: "2024-06-01",
    lat: 38.72,
    lon: -9.14,
    temp: 22,
    rain: 0.12,
  },
  {
    name: "Osaka",
    country: "JP",
    timezone: "Asia/Tokyo",
    launched: "2025-04-01",
    lat: 34.69,
    lon: 135.5,
    temp: 26,
    rain: 0.35,
  },
] as const;
// Station names and their share of trips, from the kit's trips.csv sample.
const STATIONS: ReadonlyArray<readonly [city: number, name: string, weight: number]> = [
  [0, "Downtown", 1248],
  [0, "East 6th", 992],
  [0, "Mueller", 513],
  [0, "South Congress", 517],
  [0, "UT Campus", 731],
  [0, "Zilker", 767],
  [1, "Friedrichshain", 796],
  [1, "Kreuzberg", 1504],
  [1, "Mitte", 1993],
  [1, "Neukölln", 1220],
  [1, "Prenzlauer Berg", 1142],
  [1, "Tempelhof", 784],
  [2, "Alfama", 1247],
  [2, "Bairro Alto", 631],
  [2, "Belém", 930],
  [2, "Cais do Sodré", 1492],
  [2, "Marquês", 896],
  [2, "Oriente", 562],
  [3, "Bentencho", 649],
  [3, "Kyobashi", 613],
  [3, "Namba", 1284],
  [3, "Shinsaibashi", 930],
  [3, "Tennoji", 971],
  [3, "Umeda", 1588],
];
const BIKE_TYPES = [
  { id: "classic", label: "Classic", unlock: 1, perMinute: 0.15, kmh: 13, weight: 26 },
  { id: "ebike", label: "E-Bike", unlock: 1, perMinute: 0.35, kmh: 18, weight: 66 },
  { id: "ebike_cargo", label: "Cargo E-Bike", unlock: 1.5, perMinute: 0.45, kmh: 14, weight: 8 },
] as const;
const START = Date.UTC(2026, 3, 1);
const END = Date.UTC(2026, 9, 1);
const DAY_MS = 86_400_000;
// Commute peaks at 8 and 17-18, a lunch bump, quiet nights.
const HOURS = [
  1, 0.5, 0.3, 0.2, 0.3, 1, 3, 7, 9, 5, 4, 5, 6, 5, 5, 6, 8, 10, 9, 6, 4, 3, 2, 1.5,
].map((weight, hour) => [hour, weight] as const);

NodeFS.mkdirSync(outDir, { recursive: true });
const dbPath = NodePath.join(outDir, "trips.sqlite");
NodeFS.rmSync(dbPath, { force: true });
const db = new NodeSqlite.DatabaseSync(dbPath);
db.exec(`
PRAGMA page_size = 4096;
CREATE TABLE cities (
  city_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  timezone TEXT NOT NULL,
  launched_on TEXT NOT NULL
);
CREATE TABLE stations (
  station_id INTEGER PRIMARY KEY,
  city_id INTEGER NOT NULL REFERENCES cities (city_id),
  name TEXT NOT NULL,
  docks INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
CREATE TABLE bike_types (
  bike_type TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  unlock_usd REAL NOT NULL,
  per_minute_usd REAL NOT NULL
);
CREATE TABLE riders (
  rider_id INTEGER PRIMARY KEY,
  plan TEXT NOT NULL CHECK (plan IN ('member', 'casual')),
  home_city_id INTEGER NOT NULL REFERENCES cities (city_id),
  joined_on TEXT NOT NULL
);
CREATE TABLE trips (
  trip_id TEXT PRIMARY KEY,
  rider_id INTEGER NOT NULL REFERENCES riders (rider_id),
  station_id INTEGER NOT NULL REFERENCES stations (station_id),
  bike_type TEXT NOT NULL REFERENCES bike_types (bike_type),
  started_at TEXT NOT NULL,
  duration_min REAL NOT NULL,
  distance_km REAL NOT NULL,
  battery_start INTEGER,
  battery_end INTEGER,
  fare_usd REAL NOT NULL,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5)
);
CREATE INDEX trips_started_at ON trips (started_at);
CREATE INDEX trips_station ON trips (station_id);
CREATE INDEX stations_city ON stations (city_id);
CREATE VIEW trip_facts AS
SELECT t.trip_id, t.started_at, c.name AS city, s.name AS station, t.bike_type, r.plan,
       t.duration_min, t.distance_km, t.fare_usd, t.rating
FROM trips t
JOIN stations s ON s.station_id = t.station_id
JOIN cities c ON c.city_id = s.city_id
JOIN riders r ON r.rider_id = t.rider_id;
`);

db.exec("BEGIN");
const insertCity = db.prepare("INSERT INTO cities VALUES (?, ?, ?, ?, ?)");
CITIES.forEach((city, index) =>
  insertCity.run(index + 1, city.name, city.country, city.timezone, city.launched),
);
const insertStation = db.prepare("INSERT INTO stations VALUES (?, ?, ?, ?, ?, ?)");
STATIONS.forEach(([city, name], index) =>
  insertStation.run(
    index + 1,
    city + 1,
    name,
    4 * Math.round(between(3, 10)),
    round(CITIES[city]!.lat + between(-0.04, 0.04), 5),
    round(CITIES[city]!.lon + between(-0.05, 0.05), 5),
  ),
);
const insertType = db.prepare("INSERT INTO bike_types VALUES (?, ?, ?, ?)");
for (const type of BIKE_TYPES) insertType.run(type.id, type.label, type.unlock, type.perMinute);

const riderCount = Math.max(50, Math.round(tripCount / 4));
const riders: Array<{ plan: "member" | "casual"; city: number }> = [];
const insertRider = db.prepare("INSERT INTO riders VALUES (?, ?, ?, ?)");
for (let id = 1; id <= riderCount; id++) {
  const rider = {
    plan: random() < 0.62 ? ("member" as const) : ("casual" as const),
    city: Math.floor(random() * CITIES.length),
  };
  riders.push(rider);
  const joined = Date.UTC(2023, 4, 15) + Math.floor(random() * (START - Date.UTC(2023, 4, 15)));
  insertRider.run(id, rider.plan, rider.city + 1, day(joined));
}

const stationsByCity = CITIES.map((_, city) =>
  STATIONS.flatMap(([stationCity, , weight], index) =>
    stationCity === city ? [[index + 1, weight] as const] : [],
  ),
);
const insertTrip = db.prepare("INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
for (let i = 0; i < tripCount; i++) {
  const riderId = 1 + Math.floor(random() * riderCount);
  const rider = riders[riderId - 1]!;
  // Most rides start in the rider's home city.
  const city = random() < 0.9 ? rider.city : Math.floor(random() * CITIES.length);
  const stationId = pick(stationsByCity[city]!);
  const type = pick(BIKE_TYPES.map((t) => [t, t.weight] as const));
  const dayStart = START + Math.floor(random() * ((END - START) / DAY_MS)) * DAY_MS;
  const started = dayStart + pick(HOURS) * 3_600_000 + Math.floor(random() * 3_600_000);
  const duration = round(Math.min(190, Math.max(1.3, Math.exp(2.45 + 0.62 * gaussian()))), 1);
  const distance = round(Math.max(0.1, (duration / 60) * type.kmh * between(0.55, 1.1)), 2);
  const electric = type.id !== "classic";
  const batteryStart = electric && random() > 0.08 ? Math.round(between(22, 100)) : null;
  const batteryEnd =
    batteryStart === null
      ? null
      : Math.max(0, Math.round(batteryStart - duration * between(0.4, 0.9)));
  const billable = rider.plan === "member" ? Math.max(0, duration - 45) : duration;
  const fare =
    rider.plan === "member" && billable === 0
      ? 0
      : round(type.unlock + billable * type.perMinute, 2);
  const rating =
    random() < 0.42
      ? null
      : pick([
          [5, 46],
          [4, 30],
          [3, 13],
          [2, 6],
          [1, 5],
        ] as const);
  insertTrip.run(
    `T${(46_000 + i).toString(36).toUpperCase()}`,
    riderId,
    stationId,
    type.id,
    stamp(started),
    duration,
    distance,
    batteryStart,
    batteryEnd,
    fare,
    rating,
  );
}
db.exec("COMMIT");
db.exec("VACUUM");
db.close();

// Daily weather per city, keyed by city name and date the way another export would be.
const weather = ["date,city,temp_c,precip_mm,wind_kph"];
for (let at = START; at < END; at += DAY_MS) {
  const season = Math.sin(((at - START) / (END - START)) * Math.PI);
  for (const city of CITIES) {
    const rain = random() < city.rain ? round(Math.exp(between(-0.5, 3)), 1) : 0;
    const temp = round(city.temp - 6 + 9 * season + gaussian() * 2.4 - (rain > 0 ? 2 : 0), 1);
    weather.push(`${day(at)},${city.name},${temp},${rain},${round(between(4, 32), 1)}`);
  }
}
NodeFS.writeFileSync(NodePath.join(outDir, "weather.csv"), `${weather.join("\n")}\n`);

console.log(
  JSON.stringify({
    outDir,
    trips: tripCount,
    riders: riderCount,
    bytes: {
      "trips.sqlite": NodeFS.statSync(dbPath).size,
      "weather.csv": NodeFS.statSync(NodePath.join(outDir, "weather.csv")).size,
    },
  }),
);
