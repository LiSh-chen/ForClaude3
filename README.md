# 路線街景影片產生器

填入 Mapillary API token → 選起點與終點 → 選路線 → 產生街景影片。

## 純網頁版（`site/index.html`）
單一 HTML 檔，不需要 Python 或 ffmpeg，影片在瀏覽器內錄製。

- 線上版：https://lish-chen.github.io/ForClaude3/ （repo Settings → Pages → Source 選 **GitHub Actions**，推送到 `main` 後自動發佈）
- 也可下載 `site/index.html` 直接用瀏覽器開啟。

使用：
1. 填入 Mapillary token（只存在你的瀏覽器，請求直接送往 Mapillary）。
2. 在地圖點選或搜尋地址，設定起點與終點，並選擇最多 3 條候選路線之一。
3. 按「產生影片」，完成後預覽並下載（Chrome/Edge 為 mp4，其他為 webm）。

注意：錄製期間請保持分頁在前景；影片時長約為 張數 ÷ 每秒張數。影片已燒入 Mapillary 來源標註（CC-BY-SA 4.0）。

## 伺服器版（`server/`，Flask + ffmpeg）
```bash
cd server
pip install -r requirements.txt     # 另需安裝 ffmpeg
export MAPILLARY_TOKEN='MLY|...'    # 可省略，改在網頁上貼
python app.py                       # http://127.0.0.1:8000
```
任務佇列、進度與取消、mp4 預覽下載；亦有命令列 `route_video.py` 與 Dockerfile。測試：`pytest tests`。
預設只綁 127.0.0.1；對外開放前請自行加上認證。

## 授權與使用限制
- 影像：Mapillary 貢獻者，CC-BY-SA 4.0；分享影片請標註。
- 路線：OSRM（routing.openstreetmap.de）／OpenStreetMap 貢獻者；地址搜尋：Nominatim。這些公開服務有使用限制，僅適合個人少量使用。
