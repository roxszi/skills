# OCR 工具箱 · 关键字段正则(key_fields_extraction)

> 体检报告 / 病历 / 发票场景的**高频字段**提取正则。

---

## ⚠️ 通用前提

1. **OCR 文本必须先用 pdfplumber / pymupdf 二次验证** (Read 工具 PDF 不稳定)
2. **关键字段入库前必须人工对照原图** (OCR 数字 1/l/0/O 易混淆)
3. **中文字符和数字交界 `\b` 失效**, 正则里**不要用 `\b`**

---

## 一、个人身份字段

### 1.1 身份证号 (18 位)

```python
# 18 位:前 17 位数字 + 最后 1 位数字或 X
re.search(r"[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX]", text)

# 简化版(只匹配数字串)
re.search(r"[1-9]\d{16}[\dXx]", text)
```

### 1.2 出生证编号 (以 Z 开头 + 9 位)

```python
# 例:Z320302509
re.search(r"Z\d{9}", text)
```

### 1.3 姓名

```python
# 通常跟在"姓名:"后面
re.search(r"姓名[:：]\s*([^\s\n]+)", text)

# 或:姓 + 名(2-4 字)
re.search(r"姓\s*名[:：]?\s*([\u4e00-\u9fa5]{2,4})", text)
```

---

## 二、联系方式

### 2.1 手机号

```python
# 11 位,1[3-9] 开头
re.search(r"1[3-9]\d{9}", text)

# 带"电话:"前缀
re.search(r"(?:电话|手机|联系电话|移动电话)[:：]?\s*(1[3-9]\d{9})", text)
```

### 2.2 固定电话(区号 + 号码)

```python
# 例:025-12345678 / 025-1234-5678
re.search(r"0\d{2,3}[-]?\d{7,8}", text)
```

---

## 三、医疗场景字段

### 3.1 卡号 / 病案号

```python
# 江苏省人民医院:10 位数字,以 0 开头
re.search(r"0\d{9,11}", text)

# ❌ 不要用 \b:
# re.search(r"\b0\d{9,11}\b", text)  # 失败!中文/数字交界 \b 失效
```

### 3.2 报告日期 / 检查日期

```python
# 标准格式:YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
re.search(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", text)

# 带"日期:"前缀
re.search(r"(?:日期|检查日期|报告日期|就诊日期)[:：]?\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})", text)

# 中文格式:2026年07月07日
re.search(r"\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日", text)

# 时间戳:2026-07-07 10:17:59
re.search(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}", text)
```

### 3.3 年龄(婴儿 / 成人)

```python
# 月龄:4 月 4 天 / 4个月4天 / 4m4d
re.search(r"(\d+)\s*(?:月|个月)(?:(\d+)\s*天)?", text)

# 周龄:35+5 周(早产)
re.search(r"(\d+)\+(\d+)\s*周", text)

# 日龄:出生 3 天
re.search(r"(\d+)\s*天", text)

# 年龄:30 岁 5 个月
re.search(r"(\d+)\s*岁(?:\s*(\d+)\s*个月)?", text)
```

### 3.4 体重 / 身长(婴儿)

```python
# 体重:1800 g / 1.8 kg
re.search(r"(\d+(?:\.\d+)?)\s*(?:g|kg|克|千克)", text)

# 身长:42 cm
re.search(r"(\d+(?:\.\d+)?)\s*(?:cm|厘米)", text)
```

### 3.5 血压

```python
# 标准:120/80 mmHg
re.search(r"(\d{2,3})/(\d{2,3})\s*mmHg", text)

# 带"血压:"前缀
re.search(r"血压[:：]?\s*(\d{2,3})/(\d{2,3})", text)
```

---

## 四、检查项目字段

### 4.1 化验指标(检验单)

```python
# 通用模式:项目名 + 数值 + 单位
# 例:白细胞 6.5 ×10^9/L
re.search(r"(白细胞|红细胞|血红蛋白|血小板|血糖|胆固醇|甘油三酯|肌酐|尿素氮)\s*([\d.]+)\s*([×\d^/\w]+(?:/L|mg/dL|mmol/L|g/L)?)?", text)

# 中文 + 数字 + 单位(更宽松)
re.search(r"([\u4e00-\u9fa5]+)\s*([\d.]+)\s*([\u4e00-\u9fa5a-zA-Z/×\^]+)", text)
```

### 4.2 异常标记

```python
# ↑ / ↓ / H / L / 高 / 低 / 异常 / 偏高 / 偏低
re.search(r"(↑|↓|↑↑|↓↓|H|L|高|低|异常|偏高|偏低|轻度|中度|重度)", text)
```

### 4.3 参考范围

```python
# 例:3.5-9.5 ×10^9/L
re.search(r"([\d.]+)\s*[-~至到]\s*([\d.]+)", text)
```

---

## 五、诊断 / 报告字段

### 5.1 诊断关键词

```python
# "诊断:XXXX" / "初步诊断:XXXX"
re.search(r"(?:诊断|初步诊断|出院诊断|入院诊断)[:：]?\s*([\u4e00-\u9fa5、,，\s]+?)(?:\n|$)", text)

# 多个诊断(用 、 或 , 分隔)
re.search(r"诊断[:：]?\s*([\u4e00-\u9fa5、,，\s]+)", text)
```

### 5.2 检查结论

```python
# "结论:..." / "印象:..." / "结果:..."
re.search(r"(?:结论|印象|结果|意见)[:：]?\s*(.+?)(?:\n|$)", text)
```

### 5.3 医师签名

```python
# "医师:XXX" / "检查医师:XXX" / "报告医师:XXX"
re.search(r"(?:医师|检查医师|报告医师|主治医师|主任医师)[:：]?\s*([\u4e00-\u9fa5]{2,4})", text)
```

---

## 六、药品 / 用药字段

### 6.1 药品名 + 剂量

```python
# 例:西酞普兰 20 mg
re.search(r"([\u4e00-\u9fa5]{2,8})\s*(\d+(?:\.\d+)?)\s*(mg|g|μg|mL|U|IU)", text)

# 多种剂型
re.search(r"([\u4e00-\u9fa5]+)\s*(\d+(?:\.\d+)?)\s*(mg|g|μg|mL|U|IU|片|粒|袋|支)", text)
```

### 6.2 服药频次

```python
# qd / bid / tid / qid / qn / qod / prn
re.search(r"\b(qd|bid|tid|qid|qn|qod|prn|hs|ac|pc)\b", text, re.IGNORECASE)

# 中文:每日一次 / 每日两次 / 每日三次
re.search(r"每日\s*([一二三四])\s*次", text)

# 早 / 中 / 晚 / 睡前
re.search(r"(早|晨|中|晚|睡前|空腹|餐前|餐后)", text)
```

---

## 七、实验室 / 医院字段

### 7.1 医院名称

```python
# 例:江苏省人民医院 / 南京医科大学附属逸夫医院
re.search(r"([\u4e00-\u9fa5]{4,30}(?:医院|附属医院|医学院|卫生服务中心))", text)
```

### 7.2 科室

```python
# 例:眼科 / 儿童保健科 / 急诊科
re.search(r"([\u4e00-\u9fa5]{2,10}(?:科|室|部|中心))", text)
```

### 7.3 发票 / 费用

```python
# 例:金额:¥123.45 / 123.45 元
re.search(r"(?:金额|费用|总价)[:：]?\s*¥?\s*([\d.]+)\s*元?", text)

# 大写金额
re.search(r"[壹贰叁肆伍陆柒捌玖拾佰仟万亿]+元", text)
```

---

## 八、组合提取器(完整示例)

```python
import re
from typing import Any


def extract_medical_fields(text: str) -> dict[str, Any]:
    """从 OCR 文本中提取医疗场景高频字段"""

    fields = {}

    # 1. 姓名
    m = re.search(r"姓\s*名[:：]?\s*([\u4e00-\u9fa5]{2,4})", text)
    fields["name"] = m.group(1) if m else None

    # 2. 性别
    m = re.search(r"性\s*别[:：]?\s*(男|女)", text)
    fields["gender"] = m.group(1) if m else None

    # 3. 年龄(完整版,支持 "4月4天" / "4岁5个月" / "35+5 周" / "出生 3 天")
    #    ⚠️ 简化版 `(\d+\s*(?:岁|个月|月|天|周))` 会把 "4月4天" 截成 "4月"
    m = re.search(
        r"年\s*龄[:：]?\s*("
        r"\d+\s*岁(?:\s*\d+\s*个?月)?"
        r"|\d+\s*个?月(?:\s*\d+\s*天)?"
        r"|\d+\s*天"
        r"|\d+\+\d+\s*周"
        r")",
        text,
    )
    fields["age"] = m.group(1).strip() if m else None

    # 4. 卡号
    m = re.search(r"(?:卡号|病案号)[:：]?\s*(0\d{9,11})", text)
    fields["card_no"] = m.group(1) if m else None

    # 5. 电话
    m = re.search(r"(?:电话|手机|联系电话)[:：]?\s*(1[3-9]\d{9})", text)
    fields["phone"] = m.group(1) if m else None

    # 6. 报告日期(带时间补空格)
    m = re.search(r"(?:报告日期|检查日期|就诊日期)[:：]?\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s*(\d{1,2}:\d{2}:\d{2})", text)
    if m:
        # OCR 输出 date+time 之间常无空格("2026-07-0710:17:59"),后处理补上
        fields["report_date"] = f"{m.group(1)} {m.group(2)}"
    else:
        m = re.search(r"(?:报告日期|检查日期|就诊日期)[:：]?\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})", text)
        fields["report_date"] = m.group(1) if m else None

    # 7. 医院
    m = re.search(r"([\u4e00-\u9fa5]{4,30}(?:医院|附属医院))", text)
    fields["hospital"] = m.group(1) if m else None

    # 8. 科室
    m = re.search(r"([\u4e00-\u9fa5]{2,10}(?:科|室))", text)
    fields["department"] = m.group(1) if m else None

    # 9. 医师
    m = re.search(r"(?:检查医师|报告医师|医师)[:：]?\s*([\u4e00-\u9fa5]{2,4})", text)
    fields["doctor"] = m.group(1) if m else None

    return fields
```

---

## 九、踩过的坑(正则层)

| # | 现象 | 原因 | 修复 |
|---|---|---|---|
| 1 | `r"\b0\d{9,11}\b"` 不匹配中文 | `\b` 在中文字符边界失效 | 去掉 `\b`,用 `(?<![0-9])...(?![0-9])` 替代 |
| 2 | `r"\d+"` 匹配过多(电话号码里夹年份) | 没限定上下文 | 加前缀:`(?:电话\|手机)[:：]?\s*\d+` |
| 3 | "4岁4天" vs "4月4天" 读不出来 | Read 工具 PDF OCR 不稳 | 用 pdfplumber + 人工核对原图 |
| 4 | 数字 1 / l / O / 0 互相混淆 | OCR 引擎常见误识 | confidence 阈值 + 人工核对 |
| 5 | `身份证` 误匹配 `卡号` | 都是 18 位数字 | 加上下文:`身份证[:：]?\s*\d{17}[\dXx]` |

---

## 十、验证清单(入库前)

- [ ] 关键字段(卡号 / 身份证 / 电话 / 报告日期)**已人工对照原图**
- [ ] 没有用 `\b`(中文字符边界)
- [ ] 单位统一(mg / μg / mL / μIU/mL)
- [ ] 异常标记(↑↓)和数值一致
- [ ] 多页文档已合并,字段没串页