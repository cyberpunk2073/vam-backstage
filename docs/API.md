# VaM Hub — API reference

Reference for the **Virt-A-Mate Hub** (`hub.virtamate.com`) HTTP surface, derived from live responses. Numeric database fields are almost always serialized as **strings** in JSON (e.g. `"package_id": "20623"`, `"rating_count": "7"`) — treat them accordingly.

---

## Table of contents

- [Transport](#transport)
- [Actions](#actions)
  - [`getInfo` — filter options](#getinfo--filter-options)
  - [`getResources` — search / browse](#getresources--search--browse)
  - [`getResourceDetail` — single resource](#getresourcedetail--single-resource)
  - [`findPackages` — bulk resolve package names](#findpackages--bulk-resolve-package-names)
- [Downloads (binary `.var`)](#downloads-binary-var)
- [Secondary endpoints](#secondary-endpoints)
  - [`packages.json` — bulk package index](#packagesjson--bulk-package-index)
  - [Website / embedded browser URLs](#website--embedded-browser-urls)
- [Separate authenticated `/api`](#separate-authenticated-api)

---

## Transport

All actions: `POST https://hub.virtamate.com/citizenx/api.php` with `Content-Type: application/json`, `Accept: application/json`, UTF-8 JSON body. Every request carries `{"source": "VaM", "action": "<name>"}` plus action-specific fields; omit or pass `""` to disable filter slots. The server echoes effective parameters under `parameters`. HTTP is always `200` — check `status`. Action sections below omit this preamble and show only the request/response bodies.

**Cookie:** `vamhubconsent=1` (or `=yes`) — required for `.var` downloads, optional for API POSTs.

**User-Agent:** nothing server-enforced. To match the official VaM client:

```
User-Agent: UnityPlayer/2018.1.9f1 (UnityWebRequest/1.0, libcurl/7.51.0-DEV)
X-Unity-Version: 2018.1.9f1
```

**Errors** use a common envelope, with action-specific errors echoing the relevant lookup key:

**Request:**

```json
{ "source": "VaM", "action": "bogus" }
```

**Response:**

```json
{ "status": "error", "error": "Invalid action" }
```

e.g. `getResourceDetail` with unknown id → `{"status": "error", "error": "Resource not found.", "resource_id": "99999999"}`.

`findPackages` is the exception — missing keys yield per-key string-`"null"` placeholders instead.

---

## Actions

Typical flow: `getInfo` at startup → `getResources` for browse/search → `getResourceDetail` for one resource (gets `hubFiles[]` + `dependencies`) → `findPackages` for bulk name→URL resolution.

### `getInfo` — filter options

Populates filter/sort pickers (`sort`, `location`, `category`, `type` arrays; `tags` and `users` histograms) and returns a `last_update` cache-buster for [`packages.json`](#packagesjson--bulk-package-index).

**Request:**

```json
{ "source": "VaM", "action": "getInfo" }
```

**Response** (abbreviated — the 2026-04-22 capture had 3,714 tag keys and 1,878 user keys, ~300 KB total; historically up to ~11k / ~5.5k, so expect growth):

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
  "last_update": "1776818756",
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
    "Voxta Content"
  ],
  "tags": {
    "#bimbo": { "ct": 5 },
    "#blonde": { "ct": 5 },
    "#looks": { "ct": 13 },
    "#milf": { "ct": 5 },
    "18+": { "ct": 84 },
    "abs": { "ct": 38 }
    /* … 3708 more entries … */
  },
  "users": {
    "-MM-": { "ct": "1" },
    "04_PG": { "ct": "3" },
    "0thJAV": { "ct": "9" },
    "10thToaster": { "ct": "12" },
    "14mhz": { "ct": "36" },
    "50_shades": { "ct": "56" }
    /* … 1872 more entries … */
  }
}
```

- `tags[label].ct` is a JSON **integer**; `users[username].ct` is a **string** (asymmetric). Gated by `min_tag_ct` / `min_user_ct`.
- `last_update` is unix seconds (string).
- `other_options` are free-form hints, not enums.

---

### `getResources` — search / browse

Paginated list with filter + sort. `pagination.next_page` / `prev_page` are query-string fragments starting with `?&` (not full URLs); empty when absent.

**Request:**

```json
{
  "source": "VaM",
  "action": "getResources",
  "latest_image": "Y",
  "perpage": "2",
  "page": "1",
  "sort": "Latest Update"
}
```

All fields are strings. Filter slots (`location`/`category`/`type`/`username`/`tags`) take one value from the matching `getInfo` array. Non-obvious fields:

- `latest_image: "Y"` — return the latest resource image.
- `sort_secondary` — secondary sort label. Alternate syntax: join both into `sort` as `"Primary,Secondary"`.
- `searchall: "true"` — also match `username` / `tag_line` / `tags` (default `"false"`: title only).

**Response** (one of two resources inlined):

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
    "sort": "Latest Update",
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
    "total_found": 49051,
    "total_pages": 24526,
    "next_page": "?&page=2&perpage=2",
    "prev_page": ""
  },
  "resources": [
    {
      "package_id": "72299",
      "hub_hosted": "0",
      "resource_id": "66186",
      "title": "Moya - German Gamer Girl",
      "popularity": null,
      "tag_line": "Cute look of a german gamer girl called 'Moya'",
      "user_id": "129900",
      "username": "ErrorC9",
      "avatar_date": "0",
      "resource_date": "1776817697",
      "type": "Looks",
      "parent_category_id": "4",
      "discussion_thread_id": "76007",
      "external_url": "https://discord.gg/C6jX8Fp43F",
      "view_count": "1",
      "download_count": "0",
      "rating_count": "0",
      "update_count": "0",
      "review_count": "0",
      "rating_avg": "0",
      "rating_weighted": "3",
      "reaction_score": "0",
      "last_update": "1776819835",
      "thtrending_positive_ratings_per_minute": "0.000000",
      "thtrending_downloads_per_minute": "0.000000",
      "thtrending_positive_rating_count": "0",
      "tags": "babe,cute,emo,german,germany,goth,kawaii,scene girl,teen 18+,young",
      "promotional_link": "https://discord.gg/C6jX8Fp43F",
      "current_version_id": "90612",
      "version_string": "v1",
      "download_url": "",
      "release_date": "1776817697",
      "category": "Free",
      "image_url": "https://1424104733.rsc.cdn77.org/data/resource_icons/66/66186.jpg?1776817697",
      "icon_url": "https://1424104733.rsc.cdn77.org/data/avatars/m/129/129900.jpg?0",
      "hubDownloadable": "true",
      "dependency_count": 32,
      "hubFiles": [
        {
          "package_id": "72299",
          "filename": "ErrorC9.Moya_German.1.var",
          "file_size": "3974881",
          "current_version_id": "90612",
          "licenseType": "CC BY",
          "creatorName": "ErrorC9",
          "programVersion": "1.22.0.3",
          "attachment_id": "584887",
          "username": "ErrorC9",
          "urlHosted": "https://hub.virtamate.com/resources/66186/download?file=584887"
        }
      ],
      "hubHosted": "false"
    }
    /* … second resource omitted for brevity … */
  ]
}
```

- `tags` is a **comma-separated string**, not an array; empty string = none.
- `*_date` / `last_update` are unix seconds (string).
- `thtrending_*` are per-minute rolling averages used by "Trending" sorts.
- `popularity` is often JSON `null`.
- `hub_hosted` (`"0"`/`"1"`) and `hubHosted` (`"true"`/`"false"`) are redundant siblings meaning the same thing.
- `hubDownloadable: "true"` + non-empty `hubFiles[]` ⇒ downloadable from Hub. The example above is not hub-hosted yet downloadable (common).

---

### `getResourceDetail` — single resource

Same top-level shape as a `getResources.resources[*]` entry, **no outer wrapper**, plus a `dependencies` map. Address by `resource_id` **or** `package_name` (`.latest` / `.minN` / `.N` all accepted; returned `filename` is always concrete).

**Request:**

```json
{ "source": "VaM", "action": "getResourceDetail", "latest_image": "Y", "resource_id": "1179" }
```

or

```json
{ "source": "VaM", "action": "getResourceDetail", "latest_image": "Y", "package_name": "AshAuryn.Expressions.latest" }
```

Unknown id/name → `{"status": "error", "error": "Resource not found.", "resource_id": "..."}` (no top-level resource fields).

**Response** — top-level fields per `getResources`; `dependencies` array below carries one entry per shape variant (`.latest` resolved, concrete `.N` resolved, `.minN` resolved, unresolvable):

```json
{
  "package_id": "671",
  "resource_id": "211",
  "title": "Space Force",
  "username": "Spacedog",
  "type": "Scenes",
  "category": "Free",
  "version_string": "4",
  "hubDownloadable": "true",
  "hubHosted": "true",
  "dependency_count": 4,
  "hubFiles": [
    {
      "package_id": "671",
      "filename": "Spacedog.Space_Force.4.var",
      "file_size": "184027019",
      "current_version_id": "3050",
      "licenseType": "CC BY",
      "creatorName": "Spacedog",
      "programVersion": "1.19.0.0",
      "attachment_id": "20097",
      "username": "Spacedog",
      "urlHosted": "https://hub.virtamate.com/resources/211/download?file=20097"
    }
  ],
  "dependencies": {
    "Spacedog.Space_Force": [
      {
        "package_id": "19961",
        "packageName": "Molmark.Cumpack",
        "filename": "Molmark.Cumpack.latest",
        "username": "Molmark",
        "licenseType": "CC BY-NC",
        "version": "latest",
        "latest_version": "2",
        "latest_version_string": "2",
        "resource_id": "1125",
        "file_size": "3620729",
        "downloadUrl": "https://hub.virtamate.com/resources/1125/version/21060/download?file=82325",
        "latestUrl": "https://hub.virtamate.com/resources/1125/version/21060/download?file=82325",
        "promotional_link": "https://www.patreon.com/molmark"
      },
      {
        "package_id": "20623",
        "packageName": "AshAuryn.Expressions",
        "filename": "AshAuryn.Expressions.5",
        "username": "AshAuryn",
        "licenseType": "CC BY",
        "version": "5",
        "latest_version": "5",
        "latest_version_string": "5",
        "resource_id": "1179",
        "file_size": "9685521",
        "downloadUrl": "https://hub.virtamate.com/resources/1179/version/42209/download?file=230625",
        "latestUrl": "https://hub.virtamate.com/resources/1179/version/42209/download?file=230625",
        "promotional_link": "https://www.patreon.com/ashauryn"
      },
      {
        "package_id": "61219",
        "packageName": "AcidBubbles.Timeline",
        "filename": "AcidBubbles.Timeline.min178",
        "username": "Acid Bubbles",
        "licenseType": "CC BY-SA",
        "version": "min178",
        "latest_version": "291",
        "latest_version_string": "v6.5.1",
        "resource_id": "94",
        "file_size": "280677",
        "downloadUrl": "https://hub.virtamate.com/resources/94/version/81668/download?file=519338",
        "latestUrl": "https://hub.virtamate.com/resources/94/version/81668/download?file=519338",
        "promotional_link": "https://www.patreon.com/acidbubbles"
      },
      {
        "package_id": null,
        "packageName": "Xstatic.MegaParticlePack",
        "filename": "Xstatic.MegaParticlePack.latest",
        "username": null,
        "licenseType": "CC BY",
        "version": "latest",
        "latest_version": null,
        "latest_version_string": null,
        "resource_id": null,
        "file_size": null,
        "downloadUrl": null,
        "latestUrl": null
      }
    ]
  }
}
```

**Dep entries** differ from `hubFiles[]`:

- `packageName` — base name, no version.
- `filename` — dep-ref **verbatim**, no `.var`. **Do not write to disk** — build `packageName + "." + latest_version + ".var"` instead.
- `version` — raw segment: `"latest"`, `"minN"`, or numeric string.
- `latest_version` — authoritative concrete integer (string); numeric ref ⇒ equals `version`; `.latest`/`.minN` ⇒ resolved integer; unresolvable ⇒ JSON `null`. Fall back to `findPackages` when null or non-numeric.
- `latest_version_string` — creator's display version (`"v6.5.1"`), not always a number and unrelated to `version` (entry 3 in the example shows the divergence).
- `downloadUrl` ≡ `latestUrl` in every capture. No `urlHosted` on deps.
- **Unresolvable** deps keep `packageName`/`filename`/`version`/`licenseType`; everything else is JSON `null` and `promotional_link` is absent. (Contrast `findPackages`, which uses the **string** `"null"`.)

**`dependencies`** is always a single-key object. The key depends on query shape:

| Query            | Has deps | Outer key                              |
| ---------------- | -------- | -------------------------------------- |
| `package_name=X` | no       | echoes `X` verbatim (any suffix)       |
| `package_name=X` | yes      | package base name (no version segment) |
| `resource_id=N`  | no       | `""`                                   |
| `resource_id=N`  | yes      | package base name                      |

Use the array, not the key. Empty deps → value `[]` (e.g. `"dependencies": {"AshAuryn.Expressions.latest": []}` or `"dependencies": {"": []}`).

**`hubFiles[]` entries** (same shape here and in `getResources`):

- `creatorName` is display name (`"Acid Bubbles"`); `username` is URL-safe handle (`"AcidBubbles"`) — they may differ.
- `programVersion` is the VaM version the file was built against.
- `urlHosted` is the fetchable URL (see [Downloads](#downloads-binary-var)).

---

### `findPackages` — bulk resolve package names

Comma-separated list → Hub file metadata. Much cheaper than N × `getResourceDetail`. Batches of ~50 keys work. **No top-level `status`** — `packages` present means success.

**Request:**

```json
{
  "source": "VaM",
  "action": "findPackages",
  "packages": "AcidBubbles.Embody.latest,AshAuryn.Expressions.5,AcidBubbles.Timeline.min178,NoSuch.Package.1"
}
```

**Response** — one entry per key shape (`.latest`, concrete `.N`, `.minN`, missing). Resolved entries always return the concrete `.var` filename regardless of input form:

```json
{
  "packages": {
    "AcidBubbles.Embody.latest": {
      "filename": "AcidBubbles.Embody.61.var",
      "file_size": "117537",
      "licenseType": "CC BY-SA",
      "package_id": "44580",
      "resource_id": "6513",
      "username": "Acid Bubbles",
      "downloadUrl": "https://hub.virtamate.com/resources/6513/version/69006/download?file=421752"
    },
    "AshAuryn.Expressions.5": {
      "filename": "AshAuryn.Expressions.5.var",
      "file_size": "9685521",
      "licenseType": "CC BY",
      "package_id": "20623",
      "resource_id": "1179",
      "username": "AshAuryn",
      "downloadUrl": "https://hub.virtamate.com/resources/1179/version/42209/download?file=230625"
    },
    "AcidBubbles.Timeline.min178": {
      "filename": "AcidBubbles.Timeline.291.var",
      "file_size": "280677",
      "licenseType": "CC BY-SA",
      "package_id": "61219",
      "resource_id": "94",
      "username": "Acid Bubbles",
      "downloadUrl": "https://hub.virtamate.com/resources/94/version/81668/download?file=519338"
    },
    "NoSuch.Package.1": {
      "filename": "null",
      "file_size": "null",
      "licenseType": "null",
      "package_id": "null",
      "resource_id": "null",
      "downloadUrl": "null"
    }
  }
}
```

Resolved entries are a subset of `hubFiles[*]`. Missing entries have every field literally `"null"` (string, not JSON `null`); `username` is omitted. Detect with `filename === "null"` or `downloadUrl === "null"`. A `downloadUrl` ending in literal `?file=` (empty `file` param) is broken — retry by filename.

---

## Downloads (binary `.var`)

Resolve a URL from `hubFiles[*].urlHosted`, `dependencies[*][*].downloadUrl` / `latestUrl`, or `packages[*].downloadUrl`, then GET with the consent cookie and follow the `303`.

**Request:**

```
GET https://hub.virtamate.com/resources/1179/download?file=230625
Cookie: vamhubconsent=yes
```

**Response** (two hops):

```http
HTTP/2 303
Location: https://1424104733.rsc.cdn77.org/internal_data/attachments/230/230653-a292c8391771d628fcbaa2b4579c81ad.data

HTTP/2 200
Content-Type: application/octet-stream
Content-Length: 9685521
Content-Disposition: filename="AshAuryn.Expressions.5.var";
```

**URL preference:** `downloadUrl` when non-empty and ≠ `"null"`, else `urlHosted` / `latestUrl`. URLs ending in `?file=` are broken. To resolve a flexible `.latest` / `.minN` filename to the concrete version, re-query `getResourceDetail?package_name=…` (or read `meta.json` inside the downloaded `.var` zip).

---

## Secondary endpoints

### `packages.json` — bulk package index

Flat `.var` filename → numeric `resource_id` map. ~1.8 MB (2026-04-22), served from CDN77. Cache-bust with `?<getInfo.last_update>`. Keys are always concrete versioned filenames (no `.latest` / `.minN`).

**Request:**

```
GET https://s3cdn.virtamate.com/data/packages.json?1776818756
```

**Response:**

```json
{
  "!AjaX.Allwyn.1.var": 55808,
  "!AjaX.Arm_Muscles.1.var": 56669,
  "!AjaX.Jasmine.1.var": 59705,
  "!AjaX.Lorrayne.1.var": 54728,
  ".Fun_with_feet_v1.1.var": 6401,
  "0014.Emi.1.var": 59157,
  "007psy.ConditionalStateMachine_2.1.var": 65939,
  "04_PG.FollowMe.1.var": 60975,
  "051.PoA_Hangar__Armory.1.var": 35221,
  "0perfectlookalike.AlyssM.3.var": 53566,
  "10thToaster.Clara.2.var": 12425
  /* … tens of thousands more entries … */
}
```

Values are JSON **integers** (not strings).

### Website / embedded browser URLs

Plain HTML URLs, suitable for in-app WebView panels:

| Pattern                                                           | Purpose               |
| ----------------------------------------------------------------- | --------------------- |
| `https://hub.virtamate.com/resources/{resourceId}`                | Resource page         |
| `https://hub.virtamate.com/resources/{resourceId}/overview-panel` | Overview tab          |
| `https://hub.virtamate.com/resources/{resourceId}/updates-panel`  | Updates tab           |
| `https://hub.virtamate.com/resources/{resourceId}/review-panel`   | Reviews tab           |
| `https://hub.virtamate.com/resources/{resourceId}/history-panel`  | History tab           |
| `https://hub.virtamate.com/resources/?q={query}`                  | Website search        |
| `https://hub.virtamate.com/threads/{threadId}`                    | Forum thread          |
| `https://hub.virtamate.com/threads/{threadId}/discussion-panel`   | Thread discussion tab |

---

## Separate authenticated `/api`

A JSON API at `https://hub.virtamate.com/api` requiring an **API key**, distinct from the action-based `citizenx/api.php`. No confirmed request/response shapes.
