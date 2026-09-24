import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';

// 크리덴셜 타입별 입력 스키마. 값은 서버에서 AES-256-GCM 으로 암호화 저장된다.
const CRED_TYPES = {
  slack: { label: 'Slack', fields: [{ key: 'token', label: 'Bot Token (xoxb-…)' }] },
  gmail: { label: 'Gmail (앱 비밀번호)', fields: [{ key: 'user', label: 'Gmail 주소' }, { key: 'appPassword', label: '앱 비밀번호 16자리' }] },
  notion: { label: 'Notion', fields: [{ key: 'token', label: 'Integration Token (ntn_/secret_)' }] },
  youtube: { label: 'YouTube Data API', fields: [{ key: 'apiKey', label: 'API Key' }] },
  naver: { label: 'Naver Open API', fields: [{ key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client Secret' }] },
  anthropic: { label: 'Anthropic (Claude)', fields: [{ key: 'apiKey', label: 'API Key (sk-ant-…)' }] },
  webhook: { label: 'Webhook 서명 시크릿', fields: [{ key: 'secret', label: 'Signing Secret (HMAC)' }] },
  mcp: {
    label: 'MCP 서버 (stdio)',
    fields: [
      { key: 'command', label: '실행 명령 (예: npx 또는 node)' },
      { key: 'args', label: '인자 (예: -y @modelcontextprotocol/server-filesystem C:/data)' },
    ],
  },
  httpAuth: {
    label: 'HTTP 인증 (범용)',
    fields: [
      { key: 'token', label: 'Bearer 토큰 (선택)' },
      { key: 'headerName', label: '헤더 이름 (선택, 예: X-API-Key)' },
      { key: 'headerValue', label: '헤더 값 (선택)' },
      { key: 'user', label: 'Basic 사용자 (선택)' },
      { key: 'pass', label: 'Basic 비밀번호 (선택)' },
    ],
  },
};

export default function CredentialsModal({ open, onClose }) {
  const [list, setList] = useState([]);
  const [type, setType] = useState('slack');
  const [name, setName] = useState('');
  const [data, setData] = useState({});
  const [saving, setSaving] = useState(false);

  const refresh = () => api.listCredentials().then(setList).catch(() => setList([]));
  useEffect(() => {
    if (open) { refresh(); setName(''); setData({}); setType('slack'); }
  }, [open]);

  if (!open) return null;
  const schema = CRED_TYPES[type];

  const save = async () => {
    setSaving(true);
    try {
      await api.saveCredential({ name: name || schema.label, type, data });
      setName(''); setData({});
      refresh();
    } finally {
      setSaving(false);
    }
  };
  const del = async (id) => { await api.deleteCredential(id); refresh(); };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="insp-title"><span className="insp-icon" style={{ '--c': '#cc785c' }}><Icon name="key" size={15} /></span>자격 증명</span>
          <button className="insp-close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="modal-body">
          <div className="cred-list">
            {list.length === 0 && <div className="insp-note">저장된 크리덴셜이 없어요. 아래에서 추가하세요.</div>}
            {list.map((c) => (
              <div className="cred-row" key={c.id}>
                <span className="cred-chip">{CRED_TYPES[c.type]?.label || c.type}</span>
                <span className="cred-name">{c.name}</span>
                <button className="cred-del" onClick={() => del(c.id)} title="삭제"><Icon name="trash" size={14} /></button>
              </div>
            ))}
          </div>

          <div className="cred-form">
            <div className="cred-form-title">새 크리덴셜 추가</div>
            <div className="fld">
              <label>종류</label>
              <select value={type} onChange={(e) => { setType(e.target.value); setData({}); }}>
                {Object.entries(CRED_TYPES).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
              </select>
            </div>
            <div className="fld">
              <label>이름 (구분용)</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={schema.label} />
            </div>
            {schema.fields.map((f) => (
              <div className="fld" key={f.key}>
                <label>{f.label}</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={data[f.key] ?? ''}
                  onChange={(e) => setData((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            <button className="cred-save" onClick={save} disabled={saving}>
              {saving ? '저장 중…' : '크리덴셜 저장'}
            </button>
            <div className="insp-hint">🔒 값은 서버에서 AES-256-GCM 으로 암호화되어 저장되고, 목록에는 표시되지 않습니다.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
