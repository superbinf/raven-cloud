import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, CircleAlert, Clock3, History, KeyRound, LockKeyhole, Minus, Plus, Save, ShieldCheck } from "lucide-react";
import type { PasswordPolicy } from "@sentinel/shared";
import { Button, IconButton } from "@/components/ui";
import { PageHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { adminApiFetch as apiFetch } from "@/api/admin";

const defaultPolicy: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
  historyCount: 5,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
  updatedAt: "",
};

type NumberKey = "minLength" | "maxLength" | "historyCount";
type RuleKey = "requireUppercase" | "requireLowercase" | "requireNumber" | "requireSpecial";

const numberFields: Array<{ key: NumberKey; label: string; description: string; min: number; max: number; unit: string; icon: typeof KeyRound }> = [
  { key: "minLength", label: "最小长度", description: "新密码允许的最少字符数", min: 8, max: 64, unit: "位", icon: KeyRound },
  { key: "maxLength", label: "最大长度", description: "新密码允许的最多字符数", min: 8, max: 128, unit: "位", icon: LockKeyhole },
  { key: "historyCount", label: "密码历史", description: "禁止重复使用最近的密码", min: 0, max: 20, unit: "次", icon: History },
];

const rules: Array<{ key: RuleKey; label: string; description: string }> = [
  { key: "requireUppercase", label: "大写字母", description: "至少包含 1 个 A-Z" },
  { key: "requireLowercase", label: "小写字母", description: "至少包含 1 个 a-z" },
  { key: "requireNumber", label: "数字", description: "至少包含 1 个 0-9" },
  { key: "requireSpecial", label: "特殊字符", description: "至少包含 1 个符号字符" },
];

export function PasswordPolicyPage() {
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    apiFetch<PasswordPolicy>("/api/password-policy")
      .then(setPolicy)
      .catch((error) => setToast({ tone: "warning", text: error instanceof Error ? error.message : "密码策略加载失败" }));
  }, []);

  const validationError = useMemo(() => {
    if (!policy) return "";
    if (policy.minLength < 8 || policy.minLength > 64) return "最小长度必须为 8-64 位";
    if (policy.maxLength < policy.minLength || policy.maxLength > 128) return "最大长度必须不小于最小长度，且不能超过 128 位";
    if (policy.historyCount < 0 || policy.historyCount > 20) return "密码历史次数必须为 0-20 次";
    return "";
  }, [policy]);

  const updateNumber = (key: NumberKey, value: number) => {
    setPolicy((current) => current ? { ...current, [key]: Math.floor(value) } : current);
  };

  const stepNumber = (key: NumberKey, delta: number, min: number, max: number) => {
    if (!policy) return;
    updateNumber(key, Math.min(max, Math.max(min, policy[key] + delta)));
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!policy || validationError) return;
    setSaving(true);
    try {
      const saved = await apiFetch<PasswordPolicy>("/api/password-policy", {
        method: "PUT",
        body: JSON.stringify(policy),
      });
      setPolicy(saved);
      setToast({ tone: "success", text: "平台密码策略已更新" });
    } catch (error) {
      setToast({ tone: "warning", text: error instanceof Error ? error.message : "密码策略保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const enabledRuleCount = policy ? rules.filter((rule) => policy[rule.key]).length : 0;
  const summaryItems = policy ? [
    `密码长度 ${policy.minLength}-${policy.maxLength} 位`,
    ...rules.filter((rule) => policy[rule.key]).map((rule) => `必须包含${rule.label}`),
    policy.historyCount ? `不能与最近 ${policy.historyCount} 次密码相同` : "允许使用历史密码",
  ] : [];

  return <>
    <PageHeader
      eyebrow="ACCOUNT SECURITY"
      title="密码策略"
      description="统一约束云端平台账号的新建、重置和个人改密。"
      actions={<Button type="submit" form="password-policy-form" disabled={!policy || saving || Boolean(validationError)}><Save size={16} />{saving ? "保存中..." : "保存策略"}</Button>}
    />
    {!policy ? <div className="password-policy-loading"><ShieldCheck size={24} /><span>正在读取平台密码策略</span></div> : <div className="password-policy-layout">
      <form id="password-policy-form" className="password-policy-editor" onSubmit={save}>
        <section className="password-policy-section" aria-labelledby="password-length-title">
          <header><span><LockKeyhole size={18} /></span><div><h2 id="password-length-title">长度与历史限制</h2><p>控制密码长度范围及可重复使用规则。</p></div></header>
          <div className="password-number-grid">{numberFields.map((field) => {
            const FieldIcon = field.icon;
            return <label className="password-number-control" key={field.key}>
              <span className="password-number-copy"><FieldIcon size={16} /><span><strong>{field.label}</strong><small>{field.description}</small></span></span>
              <span className="password-stepper">
                <IconButton label={`减少${field.label}`} onClick={() => stepNumber(field.key, -1, field.min, field.max)} disabled={policy[field.key] <= field.min}><Minus size={15} /></IconButton>
                <span><input aria-label={field.label} type="number" min={field.min} max={field.max} value={policy[field.key]} onChange={(event) => updateNumber(field.key, Number(event.target.value))} /><small>{field.unit}</small></span>
                <IconButton label={`增加${field.label}`} onClick={() => stepNumber(field.key, 1, field.min, field.max)} disabled={policy[field.key] >= field.max}><Plus size={15} /></IconButton>
              </span>
            </label>;
          })}</div>
          {validationError && <div className="password-policy-error" role="alert"><CircleAlert size={16} />{validationError}</div>}
        </section>
        <section className="password-policy-section" aria-labelledby="password-complexity-title">
          <header><span><ShieldCheck size={18} /></span><div><h2 id="password-complexity-title">复杂度规则</h2><p>启用的字符类型会在创建、重置和修改密码时强制校验。</p></div><em>{enabledRuleCount}/4 已启用</em></header>
          <div className="password-rule-list">{rules.map((rule) => <label key={rule.key}>
            <span><strong>{rule.label}</strong><small>{rule.description}</small></span>
            <span className="switch"><input type="checkbox" checked={policy[rule.key]} onChange={(event) => setPolicy((current) => current ? { ...current, [rule.key]: event.target.checked } : current)} /><span /><em>{policy[rule.key] ? "已启用" : "已停用"}</em></span>
          </label>)}</div>
        </section>
      </form>
      <aside className="password-policy-summary" aria-labelledby="policy-summary-title">
        <header><span><KeyRound size={19} /></span><div><h2 id="policy-summary-title">策略摘要</h2><p>保存后对下一次设置或修改密码生效。</p></div></header>
        <div className="password-policy-score"><span>当前强度</span><strong>{enabledRuleCount >= 4 && policy.minLength >= 12 ? "严格" : enabledRuleCount >= 2 ? "标准" : "宽松"}</strong><div><i style={{ width: `${Math.min(100, 28 + enabledRuleCount * 14 + Math.min(policy.minLength, 20))}%` }} /></div></div>
        <ul>{summaryItems.map((item) => <li key={item}><Check size={14} /><span>{item}</span></li>)}</ul>
        <footer><Clock3 size={14} /><span>{policy.updatedAt ? `上次更新 ${new Date(policy.updatedAt).toLocaleString("zh-CN", { hour12: false })}` : "尚未记录更新时间"}</span></footer>
      </aside>
    </div>}
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}
