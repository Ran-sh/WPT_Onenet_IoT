# ONENETapp TX/RX 双设备演进路线

状态：网关链路已实验台验证，自建双设备 UI 仍为规划。当前线上 V5.1.3 页面仍以发射端单设备为主。主仓库默认开发分支 `main` 的统一网关候选（`Arduino_Project/ESP32S3_Unified_Gateway/`）已在控制板断功率条件下完成 STM32 ←UART→ ESP32-S3 ←MQTT→ OneNET TX、ESP32-S3 ←BLE→ nRF52840、ESP32-S3 ←MQTT→ OneNET RX 真实上/下行闭环，未发送 START/ON；但 ONENETapp 的 RX 配置、看板、历史、告警、命令确认和 TX/RX 时间对齐曲线尚未实现。

## 目标设备

- `TX_001`：现有 STM32F103 → ESP8266 → OneNET 发射端设备。
- `RX_001`：nRF52840 → ESP32-S3 N16R8 → OneNET 接收端设备；该网关链路已在实验台完成真实上/下行验证，ONENETapp 双设备页面仍为规划。

两端使用独立 Product ID、Device Name、Token、请求状态、重试和命令确认链。凭据不写入仓库，不在日志或导出文件中显示。

## 配置模型

目标结构示意：

```json
{
  "tx": {
    "productId": "由用户配置",
    "deviceName": "TX_001",
    "token": "仅保存在受保护的本地存储或后端"
  },
  "rx": {
    "productId": "由用户配置",
    "deviceName": "RX_001",
    "token": "仅保存在受保护的本地存储或后端"
  }
}
```

实现时必须提供单设备旧配置的显式迁移、字段验证、版本号和失败回滚；不得把一个设备的凭据复制给另一个设备。

## 接收端属性

统一网关实际发布到 OneNET RX 的完整属性集合（字段与固件 `Mqtt_Task_Publish_Rx_Telemetry` 一致，上报路径已在实验台断功率条件下验证）：

遥测/本地状态：

- `RX_IMon`
- `RX_Current_uA`
- `RX_BoneP`
- `RX_BoneN`
- `RX_BoneV`
- `RX_Resistance`
- `RX_Vout`
- `RX_Limit`
- `RX_Stim`
- `RX_Connected`
- `RX_Valid`
- `RX_FaultReason`
- `RX_FaultFlags`

链路/派生健康：

- `RX_BleOnline`
- `RX_MqttOnline`
- `RX_GatewayOnline`
- `RX_WifiOnline`
- `RX_TelemetryFresh`
- `RX_State`
- `RX_Safe`

命令审计：

- `RX_Command`
- `RX_CommandResult`
- `RX_CommandSequence`

`RX_LastTelemetryTime` 目前没有可信 UTC/SNTP 来源，暂不发布；OneNET 属性时间戳为当前权威时间，禁止用 `millis()` 冒充 UTC。

以上字段由统一网关上报；仍为规划的是自建 ONENETapp 的 RX 属性展示、历史、告警和控制 UI，不是网关上报本身。

字段类型、范围、单位和无效值策略必须与 `D:\A_Bone_healing\RXcode` 的活动协议和 ESP32 解析器共同确认后才能进入生产模型。

## 页面拆分

双设备支持至少包括：

1. TX/RX 独立配置和连接诊断。
2. 发射端看板、历史、告警和命令确认。
3. 接收端看板、历史、告警和命令确认。
4. TX/RX 联动曲线、数据新鲜度和未匹配点标记。
5. 设备级轮询防重入、隐藏/卸载清理和独立错误恢复。

只在现有仪表盘增加接收端卡片不构成完整双设备支持。

## 状态与危险控制

页面必须分别展示：发射端在线、接收端网关在线、RX MQTT、RX BLE、RX 数据有效、RX 刺激、RX 故障、数据过期、预览/真实数据和命令结果。

- TX 命令成功只认 STM32 ACK。
- RX 命令成功只认 nRF52840 状态 Notify。
- MQTT 发布、HTTP 200、BLE 写入和在线标志都不是硬件执行确认。
- BLE 断开或遥测过期时禁用 `START`，不显示旧值为实时值，不伪造 `STOP` 或安全状态。

## 时间对齐

TX/RX 历史数据按时间戳对齐，不按数组下标连接。实现前固定以下策略之一并写入测试：

- 最近时间点匹配并设置最大容差。
- 固定时间桶并保留桶内聚合规则。
- 对无法匹配、乱序、重复、跨日和时钟漂移数据显式标记。

任何插值或外推必须可见、可关闭，且不能掩盖数据过期。

## 物理量限制

接收端刺激电流不是无线接收功率。只有确认接收端具备真实接收功率或整流输出电流测量、单位和同步采样后，才允许计算效率；否则不生成效率曲线或用其他量替代。

## 分阶段验收

1. 双设备配置、存储迁移和请求隔离通过主机契约测试。
2. RX 状态、新鲜度、告警和危险控制门控通过离线测试。
3. TX/RX 时间对齐覆盖容差、乱序、缺失、跨日和漂移。
4. ESP32 与 OneNET 真实上下行、命令确认已在控制板断功率实验台验证；BLE 断线恢复和长时间运行仍需完成实机验证。
5. 通过安全评审后再部署；规划文档和静态测试不能替代线上验收。
