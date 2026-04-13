# Lark Folder → MinIO Transfer Analysis

## Goal

Thiết kế một pipeline đẩy nhiều file lớn từ folder của Lark sang MinIO sao cho:

- không chậm toàn hệ thống
- không block khi xử lý số lượng lớn file
- không mất file khi mạng lỗi hoặc worker chết giữa chừng
- có thể retry / resume an toàn
- có thể mở rộng khi tăng số lượng file

---

## Bài toán thực tế

Nếu làm theo kiểu đơn giản:

1. list file từ Lark
2. download full file về memory hoặc local temp
3. upload tuần tự lên MinIO

thì dễ gặp các vấn đề:

- RAM tăng mạnh với file nặng
- throughput thấp vì xử lý tuần tự
- block cả process khi một file quá lớn hoặc mạng chậm
- fail giữa chừng thì phải upload lại từ đầu
- dễ bị upload trùng hoặc bỏ sót file khi retry không có trạng thái rõ ràng

---

## Kết luận kiến trúc ở mức cao

Phương án phù hợp nhất là:

**streaming + queue + worker pool + multipart upload + checkpoint + idempotency + verify sau upload**

Nói ngắn gọn:

- không giữ full file trong memory
- không xử lý toàn bộ bằng 1 process sync duy nhất
- mỗi file là một job độc lập
- file lớn dùng multipart upload lên MinIO
- mọi tiến trình đều có trạng thái để resume / retry

---

## Kiến trúc đề xuất

### 1. Enumerator

Nhiệm vụ:

- đọc danh sách file từ một folder Lark
- lấy metadata tối thiểu: `fileId`, `fileName`, `size`, `modifiedAt`, `checksum nếu có`, `downloadUrl/token nếu có`
- ghi vào job store / queue

Không nên:

- vừa list vừa upload ngay trong cùng một luồng xử lý dài

---

### 2. Job Queue

Mỗi file là một job riêng, ví dụ trạng thái:

- `pending`
- `downloading`
- `uploading`
- `verifying`
- `completed`
- `failed`
- `retry_scheduled`

Job cần có các trường quan trọng:

- `jobId`
- `sourceFileId`
- `sourcePath`
- `targetBucket`
- `targetObjectKey`
- `size`
- `uploadId` (nếu multipart)
- `uploadedParts`
- `retryCount`
- `lastError`
- `status`
- `startedAt`, `updatedAt`, `completedAt`

Mục tiêu:

- tách khâu liệt kê file khỏi khâu transfer
- dễ scale nhiều worker
- tránh block một tiến trình lớn

---

### 3. Transfer Worker Pool

Worker làm nhiệm vụ:

1. nhận job
2. mở stream download từ Lark
3. stream trực tiếp sang MinIO
4. cập nhật checkpoint định kỳ
5. verify kết quả
6. mark `completed`

Nguyên tắc quan trọng:

- **stream trực tiếp** thay vì tải full file vào RAM
- giới hạn số worker chạy song song
- giới hạn số file lớn xử lý đồng thời

---

### 4. Multipart Upload cho file lớn

Khi file lớn, nên chia part và upload multipart lên MinIO.

Lợi ích:

- part nào xong thì được ghi nhận
- fail giữa chừng không cần upload lại toàn bộ file
- tối ưu tốt hơn cho mạng không ổn định
- có thể tune concurrency theo part

Decision rule gợi ý:

- file nhỏ: upload thường hoặc stream 1 luồng
- file lớn: multipart upload

Part size thực tế nên được tune theo:

- bandwidth
- latency
- giới hạn API của nguồn và đích
- số lượng file chạy song song

---

### 5. Checkpoint / Resume Store

Đây là phần cực quan trọng để tránh mất file.

Nên lưu:

- `uploadId`
- part nào đã upload xong
- offset/bytes đã xử lý
- checksum tạm thời nếu cần
- thời điểm heartbeat cuối cùng

Nếu worker chết giữa chừng:

- job không bị mất
- worker khác có thể resume
- hoặc abort upload cũ rồi khởi tạo lại theo rule rõ ràng

Không có checkpoint thì:

- retry dễ bị upload lại từ đầu
- khó biết file nào đang dở dang
- dễ dẫn tới trạng thái sai giữa Lark và MinIO

---

### 6. Idempotency

Retry mà không có idempotency là nguồn gốc của duplicate hoặc overwrite lỗi.

Nên có một khóa logic ổn định, ví dụ:

- `sourceFileId + sourceVersion`
- hoặc `sourcePath + size + modifiedAt`

Mục tiêu:

- cùng một file nếu retry nhiều lần thì vẫn map về cùng một job logic
- không tạo object trùng nếu thực tế đã upload xong

---

### 7. Verify sau upload

Chỉ đánh dấu `completed` khi verify xong.

Nên đối soát:

- object tồn tại trên MinIO
- size khớp
- checksum/etag/hash khớp nếu lấy được
- metadata chính xác

Nếu không verify:

- có thể báo thành công nhưng object bị thiếu part hoặc hỏng dữ liệu

---

## Nguyên tắc chống chậm / chống block

### A. Tách concurrency theo 2 tầng

Không nên chỉ có một tham số `concurrency`.

Nên có ít nhất:

- `maxConcurrentFiles`
- `maxConcurrentPartsPerFile`

Ví dụ:

- nhiều file nhỏ → tăng `maxConcurrentFiles`
- ít file rất lớn → giảm `maxConcurrentFiles`, tăng hoặc tối ưu `maxConcurrentPartsPerFile`

---

### B. Backpressure

Nếu Lark download chậm hoặc MinIO upload chậm, pipeline phải tự giảm nhịp.

Nếu không có backpressure:

- buffer phình ra
- memory tăng cao
- worker bị nghẽn

---

### C. Adaptive concurrency

Concurrency không nên cố định mãi.

Có thể điều chỉnh theo:

- tỷ lệ lỗi từ Lark
- rate limit
- network throughput
- CPU / RAM / disk pressure

Khi bị rate-limit hoặc timeout tăng cao:

- giảm số job song song
- tăng backoff

---

## Chiến lược retry đúng

Retry nên có:

- exponential backoff
- jitter
- max retry per file
- phân loại lỗi retryable / non-retryable

Ví dụ lỗi retryable:

- timeout
- network reset
- 429 / rate limit
- 5xx tạm thời

Ví dụ lỗi không nên retry vô hạn:

- file không tồn tại
- token hết hạn nhưng không refresh được
- permission denied cố định
- metadata sai

---

## Failure modes cần nghĩ trước

### 1. Worker chết giữa lúc upload

Giải pháp:

- heartbeat + checkpoint
- timeout job lease
- worker khác resume hoặc restart an toàn

### 2. Lark trả chậm hoặc rate-limit

Giải pháp:

- throttling
- adaptive concurrency
- retry with backoff

### 3. MinIO chậm hoặc lỗi part commit

Giải pháp:

- retry theo part
- lưu trạng thái multipart
- có rule abort multipart bị orphan

### 4. Upload xong nhưng verify fail

Giải pháp:

- không mark completed
- ghi rõ nguyên nhân
- đưa vào hàng verify/reconcile riêng

---

## Metadata nên lưu cho audit và reconcile

Tối thiểu:

- source file id
- source folder path
- source modified time
- target bucket
- target object key
- upload started/completed time
- bytes transferred
- checksum / etag
- worker id
- retry count
- final status

Mục tiêu:

- truy vết file nào đã chuyển
- tìm file lỗi
- reconcile giữa nguồn và đích

---

## Luồng xử lý đề xuất

1. Enumerator đọc folder Lark
2. Tạo job cho từng file
3. Queue phân phối job cho worker
4. Worker mở stream từ Lark
5. Worker upload stream lên MinIO
6. Nếu file lớn: dùng multipart upload
7. Sau mỗi part hoặc mỗi mốc bytes: cập nhật checkpoint
8. Upload xong: verify size/checksum/object existence
9. Pass verify: mark `completed`
10. Fail: mark `retry_scheduled` hoặc `failed`

---

## Những anti-pattern nên tránh

### Anti-pattern 1: tuần tự toàn bộ file

Hậu quả:

- throughput thấp
- 1 file lỗi làm chậm cả đợt

### Anti-pattern 2: load full file vào memory

Hậu quả:

- OOM
- GC pressure
- block process

### Anti-pattern 3: không có trạng thái job rõ ràng

Hậu quả:

- không biết file nào đang chạy
- retry dễ trùng
- khó audit

### Anti-pattern 4: chỉ log lỗi nhưng không checkpoint

Hậu quả:

- khó resume
- dễ mất tiến độ thật

### Anti-pattern 5: coi upload xong là completed ngay

Hậu quả:

- object có thể lỗi nhưng hệ thống vẫn nghĩ thành công

---

## Đề xuất thực tế để bắt đầu

### Phase 1 - MVP an toàn

Mục tiêu:

- chạy được với số lượng file vừa phải
- không block
- không mất file khi worker chết

Bao gồm:

- queue cho từng file
- worker pool có concurrency giới hạn
- stream trực tiếp từ Lark sang MinIO
- multipart cho file lớn
- checkpoint cơ bản
- retry/backoff
- verify size sau upload

### Phase 2 - Production hardening

Bao gồm:

- adaptive concurrency
- checksum đầy đủ
- reconcile job định kỳ
- orphan multipart cleanup
- dashboard metrics / alerting
- dead-letter queue

---

## Các quyết định cần bàn tiếp

1. Stack sẽ dùng gì?
   - Node.js
   - Python
   - Go

2. Queue dùng gì?
   - Redis/BullMQ
   - RabbitMQ
   - Kafka
   - DB-backed queue

3. Checkpoint store dùng gì?
   - Postgres
   - Redis
   - MongoDB
   - Dynamo-like store

4. Rule chia file lớn / nhỏ?
   - ngưỡng bao nhiêu MB/GB thì bật multipart

5. Mục tiêu throughput?
   - ưu tiên tốc độ tối đa
   - hay ưu tiên ổn định và dễ recover

6. Có cần near real-time sync hay batch sync?

---

## Recommendation hiện tại

Nếu chưa có codebase và muốn phương án dễ triển khai nhưng vẫn an toàn:

- dùng **worker queue + streaming upload + multipart + checkpoint DB**
- bắt đầu với **concurrency bảo thủ**
- ưu tiên **độ an toàn và resume được** trước khi đẩy tối đa throughput

Nói ngắn gọn:

**đừng làm một script sync tuần tự. Hãy làm một transfer pipeline có trạng thái.**

---

## Next discussion options

Ở bước tiếp theo có thể bàn 1 trong các hướng sau:

1. chốt kiến trúc production-ready chi tiết hơn
2. chọn stack (Node.js / Python / Go)
3. thiết kế schema bảng job/checkpoint
4. thiết kế flow retry/resume cụ thể
5. bắt đầu scaffold project structure
