# Library location data

The runtime file is `extension/data/library-locations.json`. It contains public ZIP-area center points and supported library branch locations. These are public geographic records, not user locations or saved preferences.

The generated file is included so the extension works without a data download. Raw ZIP archives are local build inputs. They are not committed or included in the extension package.

To rebuild, put the following source archives in `data/source/`, then run `npm run build:directory`. You can also pass source paths with `python3 scripts/build-library-directory.py --imls PATH --zcta PATH`.

| Local filename | Public dataset | SHA-256 of the input used for this version |
| --- | --- | --- |
| `imls-pls-fy2024.csv.zip` | [IMLS FY 2024 Public Libraries Survey CSV archive](https://www.imls.gov/sites/default/files/2026-06/pls_fy2024_csv.zip) | `6aad0913b6630879f0f859e4b54cd062b3c6e9853218153ca5e4aa2d678a11e7` |
| `census-zcta-2025.zip` | [Census Bureau 2025 Gazetteer ZCTA archive](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip) | `51516a4283bab5cd2376eec75609ddc4b363a18297e8adeeaac7b03cf7c84dbe` |

The script adds the UW Suzzallo and Allen Libraries location because academic libraries are not in the public-library outlet file. Nearby distance is approximate. It does not establish library-card eligibility.
