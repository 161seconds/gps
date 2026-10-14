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

Bật **Tìm đường ô tô ngắn nhất** sau khi chọn hai điểm. Tuyến màu hồng lấy từ Valhalla trên mạng đường OpenStreetMap, tối ưu khoảng cách, tuân theo đường một chiều và hạn chế ô tô trong dữ liệu bản đồ. Đổi điểm sẽ tự tìm lại; lỗi hoặc không có đường sẽ xóa tuyến, không thay bằng đường thẳng. Tọa độ được ghép vào đường gần nhất trong phạm vi 200 m; không vẽ đoạn nối giả từ điểm chọn tới đường. Điểm GPS độc lập với tuyến này.

Định tuyến dùng [dịch vụ công cộng FOSSGIS](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/), gửi tọa độ hai điểm tới dịch vụ, tối đa một yêu cầu/giây mỗi tab. Dịch vụ không đảm bảo hoạt động liên tục; dữ liệu đường có thể thiếu hoặc cũ. Chế độ `shortest` và `disable_hierarchy_pruning` tối ưu khoảng cách; nếu máy chủ cảnh báo vượt giới hạn tìm kiếm đầy đủ (`205`), ứng dụng báo lỗi, không vẽ tuyến chưa được đảm bảo ngắn nhất. Demo lưu chế độ tìm đường riêng từng tab; dùng máy chủ Valhalla riêng khi cần tuyến dài hoặc tải lớn.

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

Self-check kiểm tra giao diện bằng Node, định tuyến với phản hồi mẫu (geometry, lỗi, hủy tuyến cũ), hai kết nối SignalR thật: điểm đầu/cuối, GPS phát đến cả hai màn, validation, bỏ điểm GPS cũ, snapshot khi kết nối lại. Server phải đang chạy. Có thể đổi URL bằng biến môi trường `GPS_URL`.

## Giới hạn

- Một phiên dùng chung, không tài khoản/token/tạo chuyến/hết hạn. Ai có URL đều xem và gửi vị trí; chỉ bật GPS trên một điện thoại mỗi lần test.
- Chỉ giữ hai mốc và điểm GPS cuối trong RAM. Restart xóa dữ liệu; cùng URL vẫn dùng được.
- Không có mô phỏng GPS, lưu lịch sử, tìm địa chỉ, chỉ dẫn rẽ từng bước hoặc nghiệp vụ Pegaxus.
- Bản đồ dùng OpenStreetMap với attribution và `strict-origin-when-cross-origin` để gửi Referer hợp lệ. Không proxy hoặc tải tile hàng loạt.
- Tunnel chuyển dữ liệu qua Cloudflare. Chưa thay thế cơ chế xác thực/lưu trữ của dự án chính.
