"""Build the extension's local ZIP-to-supported-library lookup index."""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPPORTED = {
    "kcls": "WA0059",
    "spl": "WA0064",
    "sfpl": "CA0114",
    "oakland": "CA0081",
    "marin": "CA0065",
    "smcl": "CA0120",
    "sjpl": "CA0115",
}
CUSTOM_SYSTEMS = {
    # Academic catalogs are outside the IMLS public-library outlet dataset.
    "uw": {
        "name": "University of Washington Libraries",
        "outlets": [{
            "name": "Suzzallo and Allen Libraries", "city": "Seattle", "state": "WA",
            "zip": "98195", "lat": 47.6557, "lon": -122.3081,
        }],
    },
}


def read_csv(archive: zipfile.ZipFile, member: str, delimiter: str = ","):
    return csv.DictReader(io.TextIOWrapper(archive.open(member), encoding="cp1252"), delimiter=delimiter)


def build(imls_path: Path, zcta_path: Path) -> dict:
    with zipfile.ZipFile(zcta_path) as archive:
        member = next(name for name in archive.namelist() if name.endswith(".txt"))
        zips = {}
        for row in read_csv(archive, member, "|"):
            code = row.get("GEOID", "")
            if re.fullmatch(r"\d{5}", code):
                try:
                    zips[code] = [float(row["INTPTLAT"]), float(row["INTPTLONG"])]
                except (KeyError, ValueError):
                    continue

    with zipfile.ZipFile(imls_path) as archive:
        admin_member = next(name for name in archive.namelist() if name.endswith("_AE_pud24i.csv"))
        outlets_member = next(name for name in archive.namelist() if name.endswith("_outlet_pud24i.csv"))
        admin = {row["FSCSKEY"]: row["LIBNAME"].strip().title() for row in read_csv(archive, admin_member)
                 if row.get("FSCSKEY") in SUPPORTED.values()}
        outlets = {library_id: [] for library_id in SUPPORTED}
        by_key = {key: library_id for library_id, key in SUPPORTED.items()}
        for row in read_csv(archive, outlets_member):
            library_id = by_key.get(row.get("FSCSKEY"))
            if not library_id or not re.fullmatch(r"\d{5}", row.get("ZIP", "")):
                continue
            try:
                lat, lon = float(row["LATITUDE"]), float(row["LONGITUD"])
            except (KeyError, ValueError):
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180) or lat == 0 or lon == 0:
                continue
            outlets[library_id].append({
                "name": row.get("LIBNAME", "").strip().title(),
                "city": row.get("CITY", "").strip().title(),
                "state": row.get("STABR", "").strip(),
                "zip": row["ZIP"], "lat": lat, "lon": lon,
            })

    systems = {library_id: {"fscsKey": key, "name": admin.get(key, ""), "outlets": outlets[library_id]}
               for library_id, key in SUPPORTED.items()}
    systems.update({library_id: {"fscsKey": None, **metadata} for library_id, metadata in CUSTOM_SYSTEMS.items()})
    return {
        "source": "IMLS FY 2024 Public Libraries Survey outlet file and U.S. Census Bureau 2025 Gazetteer ZCTAs; UW Libraries location is a manually included academic catalog",
        "systems": systems,
        "zipCentroids": zips,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imls", type=Path, default=ROOT / "data/source/imls-pls-fy2024.csv.zip")
    parser.add_argument("--zcta", type=Path, default=ROOT / "data/source/census-zcta-2025.zip")
    parser.add_argument("--output", type=Path, default=ROOT / "extension/data/library-locations.json")
    args = parser.parse_args()
    data = build(args.imls, args.zcta)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}: {len(data['zipCentroids'])} ZIP-area coordinates, "
          f"{sum(len(item['outlets']) for item in data['systems'].values())} supported outlets")
