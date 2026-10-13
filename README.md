# Pegaxus GPS realtime sandbox — UC-53

Demo độc lập để thử đường truyền GPS điện thoại trước khi tích hợp Flow 4. Backend .NET 8 + SignalR; frontend HTML/JS + Leaflet. Không sửa repository dự án chính.

## Chạy local

Yêu cầu .NET 8 trở lên, Node.js 22.

```powershell
npm ci
dotnet run --project GpsDemo.csproj
```

Mở `http://localhost:5085`. Nhấn **Create test trip**, mở **Viewer link** ở tab khác, nhấn **Run simulation** trên màn Driver. Marker và tọa độ ở cả hai màn phải cập nhật mỗi 2 giây. Dữ liệu này là mô phỏng Paris, không phải GPS thật.

```powershell
npm run check
```

Self-check kết nối SignalR thật: validation, tách quyền Driver/Viewer, cách ly chuyến, điểm cũ/trùng, giới hạn gửi, đổi nhóm và snapshot khi kết nối lại. Server phải đang chạy. Đổi URL test bằng biến môi trường `GPS_URL` nếu cần.

## Test điện thoại thật

Điện thoại phải truy cập được URL **HTTPS có chứng chỉ tin cậy**. `http://192.168.x.x:5085` không đủ điều kiện lấy GPS; `localhost` trên điện thoại là chính điện thoại.

Có thể dùng Cloudflare Tunnel chính thức:

```powershell
cloudflared tunnel --url http://localhost:5085
```

Trong workspace hiện tại đã có binary Cloudflare chính thức ở `artifacts/cloudflared.exe` (đã kiểm tra SHA-256). Có thể dùng `./artifacts/cloudflared.exe tunnel --no-autoupdate --url http://localhost:5085 --protocol http2`. URL tạm đổi khi tạo tunnel mới; giữ server và tunnel chạy trong lúc test, nhấn Ctrl+C ở cả hai terminal khi xong.

1. Mở URL HTTPS do tunnel trả về trên máy tính; tạo trip tại URL này để share links dùng đúng hostname.
2. Mở **Viewer link** trên máy tính. Mở **Driver link** trên điện thoại.
3. Trên điện thoại, nhấn **Start GPS**, cấp quyền vị trí; giữ trang mở và di chuyển ngoài trời.
4. Đối chiếu tọa độ, accuracy, timestamp và marker. Nhấn **Stop sharing**; không phát sinh gửi mới. Một request đã được server nhận trước Stop có thể vẫn hoàn tất.
5. Tắt mạng: trạng thái kết nối đổi; sau 15 giây vị trí phải báo stale. Bật mạng: viewer phải đăng ký lại nhóm và nhận snapshot mới nhất. GPS không được queue khi offline.
6. Thử từ chối quyền GPS: hiện lỗi, không giả lập thành GPS thật. Thử tab nền/khóa màn hình để xác định giới hạn trên thiết bị thực.

Tunnel chuyển tiếp dữ liệu qua Cloudflare; link Driver/Viewer là khóa truy cập chuyến thử, không gửi cho người không tham gia. Map tiles lấy từ OpenStreetMap; Leaflet và SignalR được phục vụ local.

Tile OSM cần `Referer` hợp lệ; ứng dụng dùng `strict-origin-when-cross-origin`, giữ attribution và URL tile chuẩn. Khóa chia sẻ nằm trong URL fragment nên không gửi qua `Referer` hoặc HTTP request. Nếu trình duyệt/extension chặn `Referer`, OSM vẫn có thể trả tile 403.

## Contract của sandbox

Đây là contract thử nghiệm; tài liệu dự án chưa chốt contract Flow 4.

| Kênh | Dữ liệu / hành vi |
| --- | --- |
| `POST /api/trips` | `{ tripId, driverToken, viewerToken, expiresAt }` |
| `POST /api/trips/{tripId}/locations` | Header `Authorization: Bearer <driverToken>`; body `{ latitude, longitude, accuracy, capturedAt, source }` |
| SignalR `/hubs/tracking` | `JoinTrip(tripId, token)` trả snapshot mới nhất hoặc `null`; Driver hoặc Viewer key đúng chuyến |
| Event `LocationUpdated` | `{ tripId, latitude, longitude, accuracy, capturedAt, receivedAt, sequence, source }` |

`source` là `gps` hoặc `simulation`. `capturedAt` là ISO 8601 UTC. Server yêu cầu đủ các field, tọa độ hữu hạn đúng phạm vi, accuracy không âm, timestamp trong 10 phút gần nhất và không quá 30 giây tương lai. Điểm cũ/trùng bị từ chối `409`; quá 4 điểm/giây bị từ chối `429`. Client GPS giới hạn 1 điểm/giây. Viewer dùng sequence tăng để bỏ event/snapshot cũ; vị trí stale khi captured hoặc received quá 15 giây.

Age/transit delay phụ thuộc đồng hồ thiết bị; bật tự động đồng bộ giờ khi đối chiếu độ trễ.

## Giới hạn và tích hợp

- Chỉ giữ điểm cuối trong RAM; tối đa 100 chuyến, hết hạn sau 1 giờ. Restart mất chuyến và link. Không lưu lịch sử GPS hoặc dữ liệu chính.
- Link hết hạn hoặc mất chuyến sau restart sẽ dừng chia sẻ và hiện **Create a new test trip**. Nhấn nút này để tạo và mở ngay chuyến mới; chia sẻ lại link mới cho Driver/Viewer.
- Secret demo chưa thay thế JWT/RBAC Pegaxus. Tích hợp phải xác thực Driver phụ trách chặng, Customer sở hữu chuyến, quyền nhân sự theo matrix; nhóm SignalR theo chuyến đã được cấp quyền.
- GPS không tự đổi trạng thái khởi hành/đã giao; UC-50 là thao tác riêng.
- Browser có thể dừng GPS khi vào nền/khóa màn hình. Demo web không chứng minh tracking nền liên tục.
- Mô phỏng/self-check chứng minh API và realtime; cần test điện thoại thật để xác nhận GPS, accuracy, pin, mạng và thời gian trễ thực tế.

Nguồn context: `C:\Users\acer\pegaxus-document\use-case\usecase-catalog.md` (UC-53), `business\Role_Permission_Matrix_And_RACI.md` (Flow 4), `overview\overall.md` (GPS điện thoại, không IoT).
