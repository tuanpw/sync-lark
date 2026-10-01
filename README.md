# Lark → MinIO Sync Platform, chinh sua commit check bot review pr

Platform dong bo file tu Lark Drive sang MinIO. Chi can dan link folder Lark, he thong tu dong crawl, so sanh voi MinIO, va chi download nhung file con thieu.

## Kien truc tong quan

```
                         +------------------+
                         |    Frontend      |
                         |  (Next.js:5000)  |
                         +--------+---------+
                                  |
                                  | HTTP REST
                                  v
                         +------------------+
                         |    Backend       |
                         | (Elysia:3001)    |
                         |  - API           |
                         |  - Persist JSON  |
                         +----+--------+----+
                              |        |
                    BullMQ job|        |store.json
                              v        v
+------------+      +------------------+      +----------+
|   Redis    |<---->|    Worker(s)     |----->|  MinIO   |
| (BullMQ)   |      |  - Crawl Lark   |      | (S3:9000)|
+------------+      |  - Stream upload |      +----------+
                     |  - 3 queue/5 file|
                     +--------+---------+
                              |
                              | HTTPS
                              v
                     +------------------+
                     |   Lark Drive     |
                     |   (Cloud API)    |
                     +------------------+
```

| Service      | Port  | Vai tro                                      |
|-------------|-------|----------------------------------------------|
| **Frontend**| 5000  | UI quan ly — dan link, xem tien do, lich su   |
| **Backend** | 3001  | API, quan ly session, luu tru du lieu (JSON)   |
| **Worker**  | —     | BullMQ consumer, crawl Lark, stream len MinIO  |
| **Redis**   | 6379  | Message queue (BullMQ)                         |
| **MinIO**   | 9000  | Object storage dich (S3-compatible)             |
| **MinIO Console** | 9001 | Web UI cua MinIO de duyet file            |

## Yeu cau

- [Bun](https://bun.sh/) >= 1.0
- Docker & Docker Compose
- Lark App credentials (App ID + App Secret) co quyen `drive:drive`

## Cai dat

### 1. Clone va cai dependencies

```bash
git clone <repo-url>
cd lark-minio-transfer-plan
bun install
```

### 2. Cau hinh environment

```bash
cp .env.example .env
```

Chinh sua `.env`:

```env
# Lark App (bat buoc)
LARK_APP_ID=cli_xxxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# MinIO
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
MINIO_BUCKET=lark-import

# Backend
BACKEND_PORT=3001

# Frontend
FRONTEND_PORT=5000
```

### 3. Khoi dong infrastructure

```bash
docker compose up -d redis minio
```

Kiem tra:

```bash
docker ps --filter "name=lark-transfer"
```

### 4. Chay cac service

Mo 3 terminal rieng biet:

```bash
# Terminal 1: Backend
bun run dev:backend

# Terminal 2: Worker
bun run dev:worker

# Terminal 3: Frontend
bun run dev:frontend
```

### 5. Truy cap

- **Frontend UI**: http://localhost:5000
- **Backend API**: http://localhost:3001/api
- **MinIO Console**: http://localhost:9001 (login: minioadmin/minioadmin)

## Huong dan su dung

### Buoc 1: Lay link Lark folder

1. Vao Lark Drive, mo folder can sync
2. Click **Share** → **Copy link**
3. Link co dang: `https://<workspace>.larksuite.com/drive/folder/<folderToken>`

### Buoc 2: Tao sync tren UI

1. Mo http://192.168.1.251:3020/
2. Dan link Lark vao o **"Lark folder link"**
3. Dat ten thu muc dich o **"Thu muc dich (MinIO prefix)"**
   - Vi du: `Media`, `US Products`, `Mockup`
   - File se duoc luu tai: `<ten_thu_muc>/<duong_dan_file_trong_lark>`
4. Click **"Bat dau sync"**

### Buoc 3: Theo doi tien do

- Phan **Sessions** hien thi tat ca cac session dang chay/da chay
- Click vao session de xem chi tiet:
  - Thanh progress bar
  - Danh sach tung file voi trang thai (downloading/uploading/completed/failed)
  - Dung luong da transfer

### Buoc 4: Sync lai neu co file loi

- Khi session ket thuc voi trang thai `partial_failed`:
  - Click **"Bat dau sync"** lai voi cung link va cung ten thu muc
  - He thong tu dong chi download nhung file con thieu (fill-gaps)
  - Khong download lai file da co tren MinIO

## Tinh nang chinh

### Fill-gaps (chi sync file thieu)

Moi lan sync, worker se:

1. **Load danh sach file da co tren MinIO** (theo prefix)
2. **Crawl toan bo folder Lark** (de quy)
3. **So sanh** → chi download file chua co tren MinIO
4. **Stream truc tiep** Lark → MinIO (khong buffer toan bo file vao RAM)

Nen co the chay sync nhieu lan cho cung 1 link ma khong lo duplicate.

### Sync history

Moi Lark link duoc theo doi rieng trong phan **"Sync history"**:

| Cot        | Y nghia                                |
|-----------|----------------------------------------|
| Lan       | So lan sync (1, 2, 3...)               |
| Lark      | Tong so file tren Lark                 |
| MinIO truoc| So file da co tren MinIO truoc sync   |
| Thieu     | So file can download                   |
| Da sync   | So file download thanh cong lan nay    |
| Loi       | So file download that bai              |
| MinIO sau | So file tren MinIO sau sync            |
| Status    | completed / partial_failed             |

### Luu tru du lieu (Persist)

- Du lieu session, sync history, transfer jobs duoc luu tai `app/backend/data/store.json`
- **Tat/bat lai backend khong mat du lieu**
- File nay tu dong duoc tao va cap nhat

### BullMQ Queue

- Backend day job vao Redis queue khi tao sync
- Worker nhan job tu queue, xu ly doc lap
- Cau hinh: **3 session dong thoi** (moi session chay 5 file song song)
- Neu worker crash, job van con trong queue va se duoc xu ly lai

### Xu ly loi

| Loai loi                    | Hanh vi                               |
|----------------------------|---------------------------------------|
| 403 Forbidden              | **Bo qua** — khong retry               |
| 429 Rate limit             | Retry voi exponential backoff          |
| Network timeout            | Retry toi da 5 lan                     |
| File khong ton tai          | Fail va ghi log                        |

- Timeout download: 15 phut moi file
- File lon duoc stream truc tiep, khong load toan bo vao RAM

## Cau truc thu muc

```
lark-minio-transfer-plan/
├── app/
│   ├── backend/         # API server (Elysia)
│   │   ├── src/
│   │   │   ├── index.ts          # Entry point
│   │   │   ├── lib/
│   │   │   │   ├── store.ts      # Persistent JSON store
│   │   │   │   ├── queue.ts      # BullMQ queue
│   │   │   │   ├── lark-api.ts   # Lark API (list files)
│   │   │   │   ├── lark-link-parser.ts
│   │   │   │   └── lark-oauth.ts
│   │   │   └── routes/
│   │   │       ├── imports.ts    # Session CRUD + sync-links
│   │   │       ├── worker.ts     # Worker heartbeat, jobs, logs
│   │   │       └── auth.ts       # Lark OAuth
│   │   └── data/
│   │       └── store.json        # Du lieu persist (auto-generated)
│   ├── worker/          # BullMQ worker
│   │   └── src/
│   │       ├── index.ts          # BullMQ consumer + fill-gaps logic
│   │       ├── lark-api.ts       # Download/export files tu Lark
│   │       └── minio-client.ts   # Upload len MinIO
│   ├── frontend/        # Next.js UI
│   │   └── app/
│   │       ├── page.tsx          # Main page
│   │       ├── layout.tsx
│   │       └── globals.css
│   ├── shared/          # Shared types
│   │   └── src/
│   │       └── types.ts
│   └── infrastructure/
│       └── sql/                  # DB schema (cho phase sau)
├── docker-compose.yml
├── .env.example
└── package.json
```

## API Endpoints

### Import Sessions

| Method | Path                          | Mo ta                    |
|--------|-------------------------------|--------------------------|
| GET    | `/api/imports`                | Danh sach sessions       |
| GET    | `/api/imports/:id`            | Chi tiet session         |
| GET    | `/api/imports/:id/jobs`       | Danh sach jobs           |
| POST   | `/api/imports`                | Tao sync moi             |
| POST   | `/api/imports/:id/retry-failed` | Retry file loi         |
| POST   | `/api/imports/:id/cancel`     | Huy session              |

### Sync Links

| Method | Path                          | Mo ta                    |
|--------|-------------------------------|--------------------------|
| GET    | `/api/sync-links`             | Lich su sync theo link   |
| GET    | `/api/sync-links/:id`         | Chi tiet 1 link          |

### Worker

| Method | Path                          | Mo ta                    |
|--------|-------------------------------|--------------------------|
| GET    | `/api/worker/status`          | Trang thai worker        |
| POST   | `/api/worker/heartbeat`       | Worker heartbeat         |
| POST   | `/api/worker/jobs`            | Tao transfer job         |
| PATCH  | `/api/worker/jobs/:id`        | Cap nhat tien do job     |

## Cau hinh nang cao

### Thay doi concurrency

Trong `app/worker/src/index.ts`:

```ts
const CONCURRENCY = 5;   // So file download song song trong 1 session
const MAX_RETRIES = 5;   // So lan retry toi da moi file
```

Trong phan BullMQ worker:

```ts
concurrency: 3,  // So session xu ly dong thoi
```

### Deploy voi Docker Compose

```bash
# Build va chay tat ca
docker compose up -d

# Xem logs
docker compose logs -f worker
docker compose logs -f backend
```

### Xem file da sync tren MinIO

1. Mo http://localhost:9001
2. Login: `minioadmin` / `minioadmin`
3. Vao bucket `lark-import` → tim theo ten thu muc dich

## Troubleshooting

### Worker khong nhan job

- Kiem tra Redis dang chay: `docker ps | grep redis`
- Kiem tra worker connected: xem log `BullMQ worker listening on queue "lark-transfer"`
- Kiem tra UI phan "Workers" co hien thi worker khong

### File bi fail 403

- Lark app chua co quyen truy cap folder → vao Lark Admin cap quyen `drive:drive` cho app
- File thuoc folder rieng cua nguoi khac → can Lark OAuth (ket noi tai khoan)

### Sync cham voi file lon

- File lon (>100MB) duoc stream truc tiep, khong buffer vao RAM
- Timeout 15 phut moi file — neu mang cham, file rat lon co the can tang timeout
- Kiem tra bang thong giua server va Lark/MinIO

### Mat du lieu khi restart

- Du lieu luu tai `app/backend/data/store.json`
- Khi deploy Docker: volume `backend_data` giu du lieu
- **Khong xoa** file `store.json` khi dang co session running
