# VaM Hub — unified API reference (from this repo)

This document consolidates how **Virt-A-Mate Hub** (`hub.virtamate.com`) is accessed from the projects under this workspace. It is derived from the implementations in the listed folders, not from official public documentation.

**Captured Hub JSON in this repo (for schema cross-check):** `get_info.json` — full `getInfo` response; `response.json` — annotated samples for `getResourceDetail`, `getResources`, and `findPackages` (the file uses `//` section comments, which are not valid JSON if pasted verbatim).

## Which projects talk to the Hub

| Project                                                           | Hub interaction                                                                         | Primary code                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **var_browser**                                                   | Full in-game Hub UI: JSON API, `packages.json`, embedded browser URLs, `.var` downloads | `var_browser/src/hook/Hub/HubBrowse.cs`, `Hub/HubResource*.cs` |
| **VPM**                                                           | Same JSON API + CDN index + downloads; WebView for website panels                       | `VPM/Services/HubService.cs`, `VPM/Models/HubModels.cs`        |
| **VamToolbox**                                                    | `findPackages` only (resolve missing `.var` names to download URLs)                     | `VamToolbox/VamToolbox/Operations/Repo/DownloadMissingVars.cs` |
| YAVAM, VaMResourceManager, vam-party, iHV, var_inspector, VarLens | No Hub HTTP client in this repo (YAVAM only mentions Hub in docs)                       | —                                                              |

---

## Shared transport

### Primary JSON endpoint

- **URL:** `https://hub.virtamate.com/citizenx/api.php`
- **Method:** `POST`
- **Body:** JSON object (UTF-8)
- **Headers:** `Content-Type: application/json`, `Accept: application/json` (var_browser); VPM uses `application/json` on `StringContent`.

Every request includes at least:

```json
{
  "source": "VaM",
  "action": "<action name>"
}
```

### Consent cookie

Clients set a Hub consent cookie so downloads and some flows behave like the official client:

| Client      | Cookie                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| var_browser | `Cookie: vamhubconsent=1` on binary GETs; API POSTs rely on UnityWebRequest as configured               |
| VPM         | `vamhubconsent=1` or `vamhubconsent=yes` on `hub.virtamate.com` (see `HubService`, `PackageDownloader`) |
| VamToolbox  | `vamhubconsent=yes` on `.var` GET downloads                                                             |

### Secondary data: package index (not `api.php`)

- **URL:** `https://s3cdn.virtamate.com/data/packages.json`
- **Usage:** Map package filenames to resource IDs and latest version per package group; often fetched after `getInfo` returns a `last_update` query suffix (var_browser: `packagesJSONUrl + "?" + last_update`).

---

## Actions (`action` field)

### `getInfo`

Populates filter/sort lists and drives loading of `packages.json`.

**Request (minimal):**

```json
{
  "source": "VaM",
  "action": "getInfo"
}
```

**Response shape (from `HubFilterOptions` in VPM / `GetInfoCallback` in var_browser), confirmed by a live capture in `get_info.json`:**

| JSON field      | Type     | Meaning                                                                                                                                |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | string   | e.g. `"success"`                                                                                                                       |
| `parameters`    | object   | Echo of request-related keys the Hub used (see below); useful for debugging                                                            |
| `sort`          | string[] | Primary sort labels (exact order from Hub)                                                                                             |
| `other_options` | object   | Human-readable hints for search behavior (not machine enums)                                                                           |
| `location`      | string[] | Hosted-location filters: e.g. `Hub`, `Hub And Dependencies`, `External`                                                                |
| `category`      | string[] | Pay / access filters: e.g. `Free`, `Paid`, `Paid Early-Access`, `VaM2`                                                                 |
| `type`          | string[] | Resource types (Scenes, Looks, …)                                                                                                      |
| `tags`          | object   | Map **tag label** → `{ "ct": number }` — `ct` is how many resources match (minimum counts may be enforced via `parameters.min_tag_ct`) |
| `users`         | object   | Map **creator username** → `{ "ct": string \| number }` — occurrence count for the creator chooser (see `min_user_ct` in `parameters`) |
| `last_update`   | string   | Unix-epoch **string** — append as query string when fetching `packages.json` (e.g. `?1775472401`)                                      |

**`parameters` (typical keys on `getInfo`):** `action`, `location`, `category`, `username`, `tags`, `type`, `sort`, `search`, `searchall`, `page`, `perpage`, `min_tag_ct`, `min_user_ct`, `source`. Empty strings often mean “no filter sent” for that slot.

**`other_options` (documented by the Hub in captures):**

| Key         | Value meaning                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `search`    | Placeholder text: `"text to search on"`                                                                                |
| `searchall` | Explains `searchall`: default `FALSE` searches **title** only; `TRUE` also searches `username`, `tag_line`, and `tags` |

var_browser wires `sort` options into primary and secondary choosers; secondary list is the same values plus `"None"`.

#### Example `getInfo` response

A successful body is one JSON object. The **shape below** is taken from a live Hub capture (`get_info.json` in this repo). In production responses, **`tags` and `users` are huge** (on the order of **~11k** tag keys and **~5.5k** creator usernames for that snapshot); only the **first slices** of those maps are shown here so the example stays readable. **Open `get_info.json` for the complete response.**

```json
{
  "status": "success",
  "parameters": {
    "action": "getInfo",
    "location": "",
    "category": "",
    "username": "",
    "tags": "",
    "type": "",
    "sort": "",
    "search": "",
    "searchall": "false",
    "page": "1",
    "perpage": "24",
    "min_tag_ct": "5",
    "min_user_ct": "1",
    "source": "VaM"
  },
  "sort": [
    "Latest Update",
    "Hot Picks",
    "Rating",
    "Reaction Score",
    "Trending Downloads",
    "Trending Positives",
    "Downloads",
    "Most Reviewed",
    "A-Z"
  ],
  "other_options": {
    "search": "text to search on",
    "searchall": "default is FALSE. when FALSE, will only search the title. when TRUE search will also check the username, tag_line and tags fields"
  },
  "location": ["Hub", "Hub And Dependencies", "External"],
  "last_update": "1775472401",
  "category": ["Free", "Paid", "Paid Early-Access", "VaM2"],
  "type": [
    "Assets + Accessories",
    "Audio",
    "Blend Shapes",
    "Clothing",
    "Comics + Storytelling",
    "Demo + Lite",
    "Environments",
    "Guides",
    "Hairstyles",
    "Lighting + HDRI",
    "Looks",
    "Mocap + Animation",
    "Morphs",
    "Other",
    "Plugins + Scripts",
    "Poses",
    "Scenes",
    "Skins",
    "Textures",
    "Toolkits + Templates",
    "Voxta Scenes"
  ],
  "tags": {
    "#bimbo": { "ct": 5 },
    "#blonde": { "ct": 5 },
    "#looks": { "ct": 14 },
    "#milf": { "ct": 5 },
    "#redhead": { "ct": 13 },
    "#thicc": { "ct": 13 },
    ".var": { "ct": 5 },
    "14mhz": { "ct": 33 },
    "18+": { "ct": 84 },
    "1990s": { "ct": 5 },
    "2000's": { "ct": 17 },
    "2000s": { "ct": 9 },
    "2girls": { "ct": 7 },
    "3dmodel": { "ct": 7 },
    "3some": { "ct": 21 },
    "3sum": { "ct": 13 },
    "4ktexture": { "ct": 5 },
    "50 shades mocap": { "ct": 5 },
    "60fps": { "ct": 6 },
    "60s": { "ct": 12 },
    "70s": { "ct": 9 },
    "80's": { "ct": 14 },
    "80s": { "ct": 28 },
    "8k textures": { "ct": 12 },
    "90's": { "ct": 27 },
    "90s": { "ct": 30 },
    "abandoned": { "ct": 9 },
    "abs": { "ct": 38 },
    "abstract": { "ct": 5 },
    "acc": { "ct": 6 },
    "accessories": { "ct": 73 }
  },
  "users": {
    "-MM-": { "ct": "1" },
    "0014": { "ct": "1" },
    "04_PG": { "ct": "3" },
    "051Kurt": { "ct": "1" },
    "0oshadowo0": { "ct": "1" },
    "0thJAV": { "ct": "9" },
    "1023059262": { "ct": "6" },
    "10thToaster": { "ct": "12" },
    "123GG": { "ct": "3" },
    "14mhz": { "ct": "36" },
    "2-Balls": { "ct": "13" },
    "2929dance": { "ct": "5" },
    "2nd To All": { "ct": "10" },
    "2one": { "ct": "1" },
    "3Deezel": { "ct": "16" },
    "3djjdream": { "ct": "1" },
    "3Dluv4UCreator": { "ct": "4" },
    "3DNudeArt": { "ct": "11" },
    "3XVirtual": { "ct": "1" },
    "4play": { "ct": "78" },
    "50_shades": { "ct": "56" },
    "7Seed": { "ct": "1" }
  }
}
```

**Notes on the example above:**

- **`tags`**: each key is a tag string; **numeric `ct`** = number of resources with that tag (server enforces `min_tag_ct` from `parameters`).
- **`users`**: each key is a **creator username** (not a numeric user id); **`ct` is a string** in captures — treat as an integer when sorting or displaying.
- **`last_update`**: use as the cache-buster when fetching `packages.json` (e.g. `https://s3cdn.virtamate.com/data/packages.json?1775472401`).

**Request example (curl):**

```bash
curl -sS -X POST 'https://hub.virtamate.com/citizenx/api.php' \
  -H 'Content-Type: application/json' \
  -d '{"source":"VaM","action":"getInfo"}'
```

---

### `getResources`

Paginated search / browse.

**Request fields (all string values unless noted):**

| Field                | When set           | Notes                                                                                                |
| -------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `latest_image`       | Always             | `"Y"` in both var_browser and VPM                                                                    |
| `perpage`            | Always             | Page size                                                                                            |
| `page`               | Always             | 1-based page index                                                                                   |
| `location`           | If not `"All"`     | e.g. Hub-only vs dependencies (var_browser `_hostedOption`)                                          |
| `search`             | Non-empty search   | With `searchall`: `"true"`                                                                           |
| `searchall`          | With search        | `"true"`                                                                                             |
| `category`           | Pay filter         | `"Free"`, `"Paid"`, or `"All"` semantics; var_browser forces `"Free"` when “only downloadable” is on |
| `type`               | Category ≠ `"All"` | Resource type                                                                                        |
| `username`           | Creator ≠ `"All"`  | Creator filter                                                                                       |
| `tags`               | Tags ≠ `"All"`     | Tag filter                                                                                           |
| `sort`               | Always             | Primary sort label                                                                                   |
| `sort_secondary`     | VPM only           | If not `"None"`, sent as separate field                                                              |
| `sort` (var_browser) | Combined sort      | Can be `"Primary,Secondary"` when secondary ≠ `"None"`                                               |

**Response (`HubSearchResponse`), with wire-level detail from `response.json` (“search” sample):**

| Field        | Type                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `status`     | `"success"` or `"error"`                                                                                                       |
| `error`      | string if error                                                                                                                |
| `parameters` | object — echo of the request parameters the Hub applied (`action`, filters, `page`, `perpage`, `source`, `latest_image`, etc.) |
| `pagination` | object — see below                                                                                                             |
| `resources`  | array of resource summary objects (see **Resource summary** and captured example below)                                        |

**`pagination` fields (observed):**

| Field                        | Meaning                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `page`, `perpage`            | string copies of the request page size                                         |
| `total_found`, `total_pages` | numbers — result set size and page count                                       |
| `next_page`                  | query string fragment for the next page (e.g. `"?&page=2&perpage=2"`) or empty |
| `prev_page`                  | previous page fragment or empty string                                         |

**Request example:**

```json
{
  "source": "VaM",
  "action": "getResources",
  "latest_image": "Y",
  "perpage": "2",
  "page": "1",
  "location": "",
  "category": "",
  "username": "",
  "tags": "",
  "type": "",
  "sort": "",
  "search": "",
  "searchall": "false"
}
```

**Abbreviated success response** (one resource trimmed; full sample in repo `response.json`):

```json
{
  "status": "success",
  "parameters": {
    "action": "getResources",
    "location": "",
    "category": "",
    "username": "",
    "tags": "",
    "type": "",
    "sort": "",
    "search": "",
    "searchall": "false",
    "page": "1",
    "perpage": "2",
    "source": "VaM",
    "latest_image": "Y"
  },
  "pagination": {
    "page": "1",
    "perpage": "2",
    "total_found": 48924,
    "total_pages": 24462,
    "next_page": "?&page=2&perpage=2",
    "prev_page": ""
  },
  "resources": [
    {
      "package_id": "71463",
      "hub_hosted": "1",
      "resource_id": "65784",
      "title": "…",
      "tag_line": "…",
      "username": "jell",
      "type": "Poses",
      "category": "Free",
      "image_url": "https://…",
      "hubDownloadable": "true",
      "hubFiles": [
        { "filename": "….var", "urlHosted": "https://hub.virtamate.com/resources/65784/download?file=580359" }
      ]
    }
  ]
}
```

**Resource summary** (each element of `resources[]`; many values are **strings** in JSON even when numeric):

| Field                           | Role                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                        | `package_id`, `resource_id`, `title`, `tag_line`, `version_string`, `current_version_id`                                                                        |
| Creator                         | `user_id`, `username`, `icon_url`, `avatar_date`                                                                                                                |
| Classification                  | `type`, `parent_category_id`, `category`, `tags` (comma-separated string)                                                                                       |
| Engagement                      | `view_count`, `download_count`, `rating_count`, `review_count`, `update_count`, `rating_avg`, `rating_weighted`, `reaction_score`, `popularity` (may be `null`) |
| Hub flags                       | `hub_hosted` (`"0"` / `"1"`), `hubDownloadable` (`"true"` / `"false"`), `hubHosted`                                                                             |
| Links / dates                   | `discussion_thread_id`, `external_url`, `promotional_link`, `download_url`, `resource_date`, `release_date`, `last_update`, `image_url`                         |
| Trending (prefix `thtrending_`) | e.g. `thtrending_downloads_per_minute`, `thtrending_positive_ratings_per_minute`, `thtrending_positive_rating_count`                                            |
| Files                           | `dependency_count`; `hubFiles` array when hosted (see **HubFile**); entries may omit `hubFiles` when not hub-hosted                                             |

---

### `getResourceDetail`

Full detail for one resource (dependencies, files, etc.).

**Request:**

```json
{
  "source": "VaM",
  "action": "getResourceDetail",
  "latest_image": "Y",
  "resource_id": "<id>"
}
```

Or lookup by package base name:

```json
{
  "source": "VaM",
  "action": "getResourceDetail",
  "latest_image": "Y",
  "package_name": "<creator.packageOrLatest>"
}
```

**Response:** JSON object with **fields at the root** (not wrapped under `resource`). On error: `status: "error"` and `error` message. VPM deserializes the successful body as `HubResourceDetail` (`HubModels.cs`).

**Captured detail document** (`response.json`, “single”): root-level fields match the table below; `tags` may be a **comma-separated string** of tags; `hubDownloadable`, `hubHosted`, and several numeric counters are often **strings** in JSON (`"true"` / `"1"` / `"123803"`). `dependencies` is an object keyed by **package group name**; each value is an array of dependency entries (shape similar to `HubFile` but with `packageName`, `downloadUrl`, `latestUrl`, etc. — see sample).

**Abbreviated example** (excerpt; full object in `response.json`):

```json
{
  "package_id": "36167",
  "hub_hosted": "1",
  "resource_id": "34405",
  "title": "Cyber Striptease",
  "tag_line": "Anniversary Update! …",
  "username": "CuddleMocap",
  "type": "Scenes",
  "category": "Free",
  "version_string": "4.0",
  "hubDownloadable": "true",
  "hubHosted": "true",
  "dependency_count": 32,
  "tags": "cyber,cyberpunk,…",
  "hubFiles": [
    {
      "package_id": "36167",
      "filename": "CuddleMocap.012-Cyber-Striptease.4.var",
      "file_size": "43635122",
      "licenseType": "CC BY-NC-ND",
      "urlHosted": "https://hub.virtamate.com/resources/34405/download?file=368677"
    }
  ],
  "dependencies": {
    "CuddleMocap.012-Cyber-Striptease": [
      {
        "packageName": "AcidBubbles.Embody",
        "filename": "AcidBubbles.Embody.60",
        "resource_id": "6513",
        "downloadUrl": "https://hub.virtamate.com/resources/6513/version/60630/download?file=353554",
        "latestUrl": "https://…"
      }
    ]
  }
}
```

**Request examples (curl):**

```bash
curl -sS -X POST 'https://hub.virtamate.com/citizenx/api.php' \
  -H 'Content-Type: application/json' \
  -d '{"source":"VaM","action":"getResourceDetail","latest_image":"Y","resource_id":"34405"}'
```

**Resource / detail fields (high level):**

| Field                                                                                           | Role                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `resource_id`, `discussion_thread_id`, `title`, `tag_line`, `version_string`                    | Identity / copy                                                           |
| `category`                                                                                      | `"Free"` / `"Paid"`                                                       |
| `type`                                                                                          | Scenes, Looks, …                                                          |
| `username`                                                                                      | Creator                                                                   |
| `icon_url`, `image_url`                                                                         | Art                                                                       |
| `hubDownloadable`, `hubHosted`                                                                  | booleans                                                                  |
| `dependency_count`, `download_count`, `rating_count`, `rating_avg`, `last_update`               | Stats (timestamps as unix seconds)                                        |
| `hubFiles`                                                                                      | array of **file** objects                                                 |
| `tags`                                                                                          | object or alternate shapes (VPM normalizes via `FlexibleDictConverter`)   |
| Detail-only: `download_url`, `promotional_link`, `dependencies`, `review_count`, `update_count` | `dependencies` is `Record<string, HubFile[]>` keyed by package group name |

**`HubFile` (per file in `hubFiles` or dependency lists):**

| Field                                    | Role                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `filename`                               | e.g. `Creator.Name.1.var`                                                    |
| `file_size`                              | string integer bytes                                                         |
| `downloadUrl`, `urlHosted`               | Primary vs hosted URL; “effective” URL prefers `downloadUrl` if not `"null"` |
| `licenseType`                            | License string                                                               |
| `version`, `latest_version`, `latestUrl` | Versioning                                                                   |
| `promotional_link`                       | Optional marketing link                                                      |

**`hubFiles[]` entries** (from `response.json`) often also include: `package_id`, `current_version_id`, `creatorName`, `programVersion`, `attachment_id`, `username`.

**`dependencies` array entries** (same capture) extend the file shape with: `packageName`, `latest_version_string`, and omit `urlHosted` in favor of `downloadUrl` / `latestUrl`.

---

### `findPackages`

Bulk resolve package **group keys** (comma-separated) to the best-matching Hub file metadata.

**Request:**

```json
{
  "source": "VaM",
  "action": "findPackages",
  "packages": "Name.One.latest,Name.Two.latest,..."
}
```

Keys in the response object are the same strings you asked for (package base names / `.latest` / `.minN` specifiers as used in code). `findPackages` and `getResourceDetail?package_name=…` both accept `.minN` suffixes (meaning "at least version N") identically to `.latest` — the response's `filename` field is concrete in all cases.

**Response (`HubFindPackagesResponse`):**

```json
{
  "status": "success",
  "packages": {
    "<requested key>": { "...HubFile fields..." }
  }
}
```

VamToolbox only maps `filename` and `downloadUrl` into `PackageInfo`; var_browser / VPM use the full set including `resource_id`, `version`, `latest_version`, `file_size`, `licenseType`, `urlHosted`, `latestUrl`, `promotional_link`.

If a package is missing, entries may be absent or filled with `"null"` URLs; clients synthesize placeholder objects.

**Wire example** from `response.json` (“bulk find”) — some clients also wrap with `status: "success"`; this capture shows only the `packages` map:

```json
{
  "packages": {
    "AcidBubbles.Embody": {
      "filename": "AcidBubbles.Embody.61.var",
      "file_size": "117537",
      "licenseType": "CC BY-SA",
      "package_id": "44580",
      "resource_id": "6513",
      "username": "Acid Bubbles",
      "downloadUrl": "https://hub.virtamate.com/resources/6513/version/69006/download?file=421752"
    },
    "AcidBubbles.Glance": {
      "filename": "AcidBubbles.Glance.23.var",
      "file_size": "15974",
      "licenseType": "CC BY-SA",
      "package_id": "28385",
      "resource_id": "5461",
      "username": "Acid Bubbles",
      "downloadUrl": "https://hub.virtamate.com/resources/5461/version/56331/download?file=320930"
    }
  }
}
```

**Request example:**

```json
{
  "source": "VaM",
  "action": "findPackages",
  "packages": "AcidBubbles.Embody,AcidBubbles.Glance"
}
```

---

## Downloads (not JSON API)

After resolving a `downloadUrl` (or `urlHosted`):

- **Method:** `GET` to the URL (redirects allowed).
- **Headers:** include `vamhubconsent` cookie as above for Hub-hosted files.
- Response body is the `.var` binary (`application/octet-stream` in VamToolbox’s validation).

VPM and var_browser also handle “`.latest`” filenames by reading `meta.json` inside the zip and optionally re-querying `getResourceDetail` by package name. The same applies to `.minN` dep-ref filenames.

---

## Website / embedded browser URLs (HTML, not `api.php`)

Used for “open in browser” / WebView panels (var_browser `HubResourceItemDetail`, VPM `HubBrowserWindow`):

| Pattern                                                           | Purpose        |
| ----------------------------------------------------------------- | -------------- |
| `https://hub.virtamate.com/resources/{resourceId}`                | Resource page  |
| `https://hub.virtamate.com/resources/{resourceId}/overview-panel` | Overview tab   |
| `https://hub.virtamate.com/resources/{resourceId}/updates-panel`  | Updates        |
| `https://hub.virtamate.com/resources/{resourceId}/review-panel`   | Reviews        |
| `https://hub.virtamate.com/resources/{resourceId}/history-panel`  | History        |
| `https://hub.virtamate.com/resources/?q={query}`                  | Search (VPM)   |
| `https://hub.virtamate.com/threads/{threadId}`                    | Thread         |
| `https://hub.virtamate.com/threads/{threadId}/discussion-panel`   | Discussion tab |

---

## Client-specific notes

### var_browser

- Uses **comma-joined** `sort` for secondary sort instead of a separate `sort_secondary` field.
- `getInfo` → then GET `packages.json?{last_update}` for local update checks.
- Unity user-agent is implicit on `UnityWebRequest`; VamToolbox’s Refit interface mimics Unity headers for compatibility.

### VPM

- `HubService` documents itself as adapted from var_browser’s `HubBrowse`.
- Adds **retry** on transient HTTP failures, **caching** for search/detail/filter/packages index, and **batching** (50 names per `findPackages` call).
- **User-Agent:** `VPM/1.0` on API HTTP client.
- WebView **cookies** can be synced from embedded browser into `HubService` via `UpdateCookies`.

### VamToolbox

- **Only** `findPackages` via RestEase `POST citizenx/api.php` with `VamQuery`.
- Filters out download URLs ending with `?file=` and retries a second batch for those.
- Refit headers: `User-Agent: UnityPlayer/...`, `X-Unity-Version: 2018.1.9f1`.

---

## Types reference (C#)

Authoritative DTOs for response parsing: **`VPM/Models/HubModels.cs`** (`HubResource`, `HubResourceDetail`, `HubSearchResponse`, `HubFilterOptions`, `HubFindPackagesResponse`, `HubFile`, `HubPagination`).

## packages.json contents

```json
{
    "!AjaX.Allwyn.1.var": 55808,
    "!AjaX.Arm_Muscles.1.var": 56669,
    "!AjaX.Arm_Muscles.2.var": 56669,
    "!AjaX.Jasmine.1.var": 59705,
    "!AjaX.Lorrayne.1.var": 54728,
    "!AjaX.Lorrayne.2.var": 55617,
    "!AjaX.Lorrayne.3.var": 55617,
    "!AjaX.Lorrayne.4.var": 55617,
    "!AjaX.Lorrayne.5.var": 55617,
    "!AjaX.Lorrayne.6.var": 55617,
    "!AjaX.Lydia.1.var": 61583,
    "!AjaX.Traps_Muscles.1.var": 56670,
    "!AjaX.Traps_Muscles.2.var": 56670,
    ".Fun_with_feet_v1.1.var": 6401,
    "0014.Emi.1.var": 59157,
    "04_PG.FollowMe.1.var": 60975,
    "04_PG.Harley_Quinn.1.var": 60031,
    "04_PG.thirdPersonWalker.2.var": 60746,
    "051.PoA_Hangar__Armory.1.var": 35221,
    "051.PoA_Hangar__Armory.2.var": 35221,
    "0perfectlookalike.3db1_0.1.var": 46726,
    "0perfectlookalike.AbellD1_2.1.var": 46896,
    "0perfectlookalike.AlyssM.3.var": 53566,
    "0perfectlookalike.AlyssM.4.var": 53567,
    "0perfectlookalike.AriellK.3.var": 55016,
    ...
}
```

---

## The following is an additional research and analysis of the Hub API.

Here’s the concrete map of the **Hub-facing endpoints and action payloads** that are publicly confirmed.

## 1) Main unauthenticated/embedded Hub endpoint

**Endpoint**

```text
https://hub.virtamate.com/citizenx/api.php
```

This is the endpoint used by public tooling and by code that mirrors VaM-style Hub access. It is hardcoded in VPM, and the forum post showing decompiled VaM Hub usage also points to the same endpoint. ([GitHub][1])

---

## 2) `getInfo`

**Request**

```json
{ "source": "VaM", "action": "getInfo" }
```

VPM sends exactly that request when loading Hub filter options. ([GitHub][1])

**What it returns**

- A **filter/options payload** used to populate Hub browsing filters in VPM. The **wire schema** is documented in the main section above (`status`, `parameters`, `sort`, `other_options`, `location`, `category`, `type`, `tags`, `users`, `last_update`). A full live capture is in repo `get_info.json`. ([GitHub][1])

---

## 3) `getResources`

**Request shape**

```json
{
  "source": "VaM",
  "action": "getResources",
  "latest_image": "Y",
  "perpage": "<string-int>",
  "page": "<string-int>",

  "location": "<optional>",
  "search": "<optional>",
  "searchall": "true", // only when search is present
  "category": "<optional>", // VPM maps this from its PayType filter
  "type": "<optional>", // content category
  "username": "<optional>", // creator
  "tags": "<optional>",
  "sort": "<required by caller>",
  "sort_secondary": "<optional>"
}
```

Those exact fields are constructed in VPM’s Hub client. ([GitHub][1])

**What it returns**

- A **search/browse result payload** consumed by VPM as `HubSearchResponse`. The main section documents `status`, `parameters`, `pagination` (including `next_page` / `prev_page`), and `resources[]` fields; see repo `response.json` (“search”) for a concrete example. ([GitHub][1])

---

## 4) `getResourceDetail`

**Request by package name**

```json
{ "source": "VaM", "action": "getResourceDetail", "latest_image": "Y", "package_name": "AshAuryn.Expressions.latest" }
```

That exact payload is shown in the Hub forum thread. ([Virt-A-Mate Hub][2])

**Request by resource id**

```json
{ "source": "VaM", "action": "getResourceDetail", "latest_image": "Y", "resource_id": "1179" }
```

VPM supports both `package_name` and `resource_id`; it sets one or the other depending on the caller. ([GitHub][1])

**Confirmed response example**

```json
{
  "package_id": "20623",
  "resource_id": "1179",
  "title": "AshAuryn's Expressions (72 morphs) (Legacy)",
  "tag_line": "Legacy expression morphs",
  "user_id": "11965",
  "username": "AshAuryn",
  "avatar_date": "1674508196",
  "resource_date": "1597143244",
  "type": "Morphs",
  "parent_category_id": "4",
  "discussion_thread_id": "1421",
  "external_url": "",
  "view_count": "64545",
  "download_count": "403775",
  "rating_count": "4",
  "update_count": "3",
  "review_count": "4",
  "rating_avg": "5",
  "rating_weighted": "3.57143",
  "reaction_score": "128",
  "last_update": "1680625050",
  "promotional_link": "https://www.patreon.com/ashauryn",
  "current_version_id": "42209",
  "version_string": "5",
  "download_url": "",
  "release_date": "1680625050",
  "category": "Free",
  "image_url": "https://1387905758.rsc.cdn77.org/data/resource_icons/1/1179.jpg?1664128534",
  "icon_url": "https://1387905758.rsc.cdn77.org/data/avatars/m/11/11965.jpg?1674508196",
  "tags": "",
  "hubDownloadable": "true",
  "hubHosted": "true",
  "dependency_count": 0,
  "hubFiles": [
    {
      "package_id": "20623",
      "filename": "AshAuryn.Expressions.5.var",
      "file_size": "9685521",
      "current_version_id": "42209",
      "licenseType": "CC BY",
      "creatorName": "AshAuryn",
      "programVersion": "1.22.0.1",
      "attachment_id": "230625",
      "username": "AshAuryn",
      "urlHosted": "https://hub.virtamate.com/resources/1179/download?file=230625"
    }
  ],
  "dependencies": {
    "AshAuryn.Expressions.latest": []
  }
}
```

That example is directly from the public forum post. VPM’s code also confirms that this action returns **root-level detail fields**, plus `status=error` / `error` on failure. ([Virt-A-Mate Hub][2])

**Important response fields**

- top-level resource/package metadata
- `hubDownloadable`, `hubHosted`
- `hubFiles[]` with hosted downloadable files
- `dependencies` keyed by package name
- on error: at least `status: "error"` and `error` text ([GitHub][1])

---

## 5) `findPackages`

**Request**

```json
{ "source": "VaM", "action": "findPackages", "packages": "AshAuryn.Expressions.latest,VL_13.Lashes_2.1" }
```

That exact shape is shown on the forum, and VamToolbox defines the same request model in code. ([Virt-A-Mate Hub][2])

**Headers seen in a VaM-like client**

```text
User-Agent: UnityPlayer/2018.1.9f1 (UnityWebRequest/1.0, libcurl/7.51.0-DEV)
X-Unity-Version: 2018.1.9f1
POST /citizenx/api.php
```

VamToolbox hardcodes those headers. ([GitHub][3])

**Confirmed response shape**

```json
{
  "packages": {
    "<key>": {
      "filename": "<package filename>",
      "downloadUrl": "<download URL or null-ish string>"
    }
  }
}
```

Hub responses may also include `package_id`, `resource_id`, `file_size`, `licenseType`, `username`, etc. — see the main section and `response.json` (“bulk find”). That minimal shape is confirmed by VamToolbox’s response model: `VamResult` contains `packages`, and each `PackageInfo` has `filename` and `downloadUrl`. The tool also explicitly filters out bad `downloadUrl` values like ones ending in `?file=` and may re-query by filename. ([GitHub][3])

**What it’s for**

- Bulk resolving package names to downloadable package entries.
- This is the cleanest action for **“I have package names, give me downloadable matches.”** ([Virt-A-Mate Hub][2])

---

## 6) Direct hosted file download endpoint

**Shape**

```text
https://hub.virtamate.com/resources/<resource_id>/download?file=<attachment_id>
```

That exact shape appears in the `urlHosted` field returned by `getResourceDetail`. ([Virt-A-Mate Hub][2])

**Observed client behavior**

- tools send a consent cookie such as:

```text
Cookie: vamhubconsent=yes
```

or set `vamhubconsent=1` in the cookie jar before doing Hub requests/downloads. VamToolbox does it on the download request; VPM sets the Hub consent cookie in its HTTP client setup. ([GitHub][3])

---

## 7) Bulk metadata feed used by some clients

**Endpoint**

```text
https://s3cdn.virtamate.com/data/packages.json
```

VPM hardcodes this as `PackagesJsonUrl`. ([GitHub][1])

**What it is**

- a bulk package metadata feed/cache source, separate from `citizenx/api.php`. The exact schema is not publicly visible in the snippets I confirmed here, so I’m not going to fake a field list. What is confirmed is that VPM uses it as a Hub resources cache layer. ([GitHub][1])

---

## 8) Separate authenticated Hub API

There is also a different endpoint:

```text
https://hub.virtamate.com/api
```

A Hub forum post says it is a JSON API that requires an **API key**. That is separate from the `citizenx/api.php` action-based endpoint above. ([Virt-A-Mate Hub][4])

I do **not** have enough confirmed public request/response shapes for `/api`, so I’m not including invented ones.

---

## Clean action table

| Action               | Endpoint                                     | Request body                                                                                                                     | Confirmed response shape                                                                                                                                                       |
| -------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getInfo`            | `/citizenx/api.php`                          | `{"source":"VaM","action":"getInfo"}`                                                                                            | `status`, `parameters`, `sort`, `other_options`, `location`, `category`, `type`, `tags`, `users`, `last_update` — see main section; full sample: `get_info.json` ([GitHub][1]) |
| `getResources`       | `/citizenx/api.php`                          | paged search/filter JSON with `search`, `category`, `type`, `username`, `tags`, `sort` etc. ([GitHub][1])                        | `status`, `parameters`, `pagination`, `resources[]` — see main section; sample: `response.json` (search) ([GitHub][1])                                                         |
| `getResourceDetail`  | `/citizenx/api.php`                          | `{"source":"VaM","action":"getResourceDetail","latest_image":"Y","package_name":"..."}` or same with `resource_id` ([GitHub][1]) | full resource detail object with `hubFiles[]`, `dependencies`, metadata; error form includes `status:"error"` + `error` ([GitHub][1]); sample: `response.json` (single)        |
| `findPackages`       | `/citizenx/api.php`                          | `{"source":"VaM","action":"findPackages","packages":"pkg1,pkg2"}` ([Virt-A-Mate Hub][2])                                         | `packages` map of keys → file metadata (`filename`, `downloadUrl`, …); sample: `response.json` (bulk find) ([GitHub][3])                                                       |
| hosted file download | `/resources/<id>/download?file=<attachment>` | GET                                                                                                                              | binary VAR payload; download URL often comes from `hubFiles[].urlHosted` or `downloadUrl` ([Virt-A-Mate Hub][2])                                                               |

The blunt version: **the useful public surface is basically `citizenx/api.php` + hosted download URLs + sometimes `packages.json`.** The four concrete action names publicly confirmed here are **`getInfo`**, **`getResources`**, **`getResourceDetail`**, and **`findPackages`**. ([GitHub][1])

I can next turn this into a **ready-to-use endpoint spec** with example curl requests for every confirmed action.

[1]: https://github.com/gicstin/VPM/blob/main/Services/HubService.cs 'VPM/Services/HubService.cs at main · gicstin/VPM · GitHub'
[2]: https://hub.virtamate.com/threads/may-i-ask-how-to-obtain-the-downloadurl-of-missingpackages.38010/ 'Question - May I ask how to obtain the downloadurl of MissingPackages? | Virt-A-Mate Hub'
[3]: https://github.com/Kruk2/VamToolbox/blob/master/VamToolbox/Operations/Repo/DownloadMissingVars.cs 'VamToolbox/VamToolbox/Operations/Repo/DownloadMissingVars.cs at master · Kruk2/VamToolbox · GitHub'
[4]: https://hub.virtamate.com/threads/hub-api.48823/?utm_source=chatgpt.com 'Hub API'
