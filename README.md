# Test GPS realtime

Một màn hình chung: chọn điểm đầu, điểm cuối; bật GPS điện thoại; xem vị trí cập nhật trực tiếp trên bản đồ.

## Chạy

Cần .NET 8 trở lên và Node.js 22.

```powershell
npm ci
dotnet run --project GpsDemo.csproj
```

Mở `http://localhost:5085`.

1. Nhấn **Chọn điểm đầu**, bấm vị trí trên bản đồ.
2. Nhấn **Chọn điểm cuối**, bấm vị trí khác. Hai điểm tự đồng bộ sang máy đang xem.
3. Mở cùng URL trên điện thoại và máy tính.
4. Trên điện thoại, nhấn **Bật GPS**, cấp quyền vị trí. Di chuyển để thấy điểm GPS cập nhật trên cả hai màn.
5. Nhấn **Dừng** để ngừng gửi GPS.

Có thể dán link Google Maps vào ô điểm đầu/cuối, nhấn **Dùng link**. Hỗ trợ link địa điểm có tọa độ, link `q`/`query`/`ll`/`center` và link chia sẻ rút gọn `maps.app.goo.gl` / `goo.gl/maps`. Bản đồ tự đưa hai điểm vào khung nhìn. Link chỉ có tên/ID địa điểm hoặc chứa nhiều điểm chỉ đường cần chọn lại một điểm trên Google Maps rồi chia sẻ.

Nút **Chế độ tối / Chế độ sáng** ở đầu trang đổi giao diện, nhớ lựa chọn trên thiết bị. Lần đầu theo giao diện hệ thống; nền bản đồ giữ màu OpenStreetMap.

Đường nối điểm đầu/cuối là đường thẳng để nhìn hai mốc, không phải tuyến đường lái xe. Điểm GPS độc lập với hai mốc này.

## Điện thoại cần HTTPS

HTTP qua IP LAN không đủ điều kiện lấy GPS. Có thể chạy tunnel đã có trong workspace:

```powershell
./artifacts/cloudflared.exe tunnel --no-autoupdate --url http://localhost:5085 --protocol http2
```

Mở URL HTTPS do tunnel trả về trên cả điện thoại và máy tính. Giữ server/tunnel chạy; giữ trang GPS mở. Trình duyệt có thể ngừng GPS khi vào nền hoặc khóa màn hình.

## Kiểm tra

```powershell
npm run check
```

Self-check kiểm tra giao diện bằng Node, hai kết nối SignalR thật: điểm đầu/cuối, GPS phát đến cả hai màn, validation, bỏ điểm GPS cũ, snapshot khi kết nối lại. Server phải đang chạy. Có thể đổi URL bằng biến môi trường `GPS_URL`.

## Giới hạn

- Một phiên dùng chung, không tài khoản/token/tạo chuyến/hết hạn. Ai có URL đều xem và gửi vị trí; chỉ bật GPS trên một điện thoại mỗi lần test.
- Chỉ giữ hai mốc và điểm GPS cuối trong RAM. Restart xóa dữ liệu; cùng URL vẫn dùng được.
- Không có mô phỏng GPS, lưu lịch sử, tìm địa chỉ, chỉ đường hoặc nghiệp vụ Pegaxus.
- Bản đồ dùng OpenStreetMap với attribution và `strict-origin-when-cross-origin` để gửi Referer hợp lệ. Không proxy hoặc tải tile hàng loạt.
- Tunnel chuyển dữ liệu qua Cloudflare. Chưa thay thế cơ chế xác thực/lưu trữ của dự án chính.
