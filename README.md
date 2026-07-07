# 镜头签

一个移动端网页原型：打开摄像头后，用 MediaPipe 手部关键点追踪食指，在画面上留下发光签名轨迹，并可录制签名过程。

## 本地运行

在这个目录里启动静态服务：

```bash
python3 -m http.server 5173
```

然后打开：

```text
http://localhost:5173
```

不要直接双击打开 `index.html`。直接打开会变成 `file://...`，很多浏览器会限制摄像头、录制或远程模型加载。

手机真机测试时，需要让手机和电脑在同一个局域网，并访问电脑的局域网 IP，例如：

```text
http://192.168.x.x:5173
```

注意：手机上打开 `http://localhost:5173` 指的是“手机自己”，不是电脑，所以会打不开。

摄像头权限通常要求 HTTPS 或 localhost。桌面本机用 `localhost` 可以直接测；手机访问局域网 IP 时，部分浏览器会限制摄像头，这时需要部署到 HTTPS 地址，比如 GitHub Pages、Vercel、Netlify，或用受信任 HTTPS 隧道。

## Vercel 上线

推荐把代码放到 GitHub，然后在 Vercel 导入这个仓库。这个项目是纯静态网页，不需要构建命令。

Vercel 设置：

- Framework Preset: Other
- Build Command: 留空
- Output Directory: 留空或 `.`
- Install Command: 留空

上线后访问：

```text
https://你的项目名.vercel.app/mobile/
```

手机摄像头需要 HTTPS，Vercel 默认提供 HTTPS，所以真机测试请优先用 Vercel 地址打开。

## 常见问题

### 手机打不开

确认这三件事：

- 电脑已经运行 `python3 -m http.server 5173`
- 手机和电脑在同一个 Wi-Fi
- 手机访问的是电脑局域网 IP，不是 `localhost`

### 电脑看不到摄像头

请用 `http://localhost:5173` 打开，不要用 `file://`。如果浏览器弹出权限提示，请允许摄像头。

### 不能点录制

录制需要先有摄像头画面。先点“开始镜头”，看到自己后再点“录制”。

## 当前功能

- 前置/后置摄像头切换
- MediaPipe “食指定位、三指握拳并捏合落笔”轨迹签名
- 触屏签名备用输入
- 笔触粗细、颜色、发光开关
- 原片、电影、黑白、霓虹、暖调滤镜
- 按单笔撤回上一笔
- 录制画面并导出 WebM 视频

## 后续可以加

- iOS 友好的 MP4 导出
- 签名自动平滑和断笔识别
- 手势开关：捏合开始/松开停止
- 海报模板、日期水印和社交分享尺寸
