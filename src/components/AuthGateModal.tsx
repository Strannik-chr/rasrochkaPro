import React, { useState } from 'react';
import { X, Shield, Eye, EyeOff, Loader2 } from 'lucide-react';

interface AuthGateModalProps {
  onClose?: () => void;
  fullScreen?: boolean;
  onSuccessLogin: (loginData: {
    user: any;
    csrfToken?: string;
    sessionToken?: string;
  }) => Promise<void>;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
}

export const AuthGateModal: React.FC<AuthGateModalProps> = ({
  onClose,
  fullScreen = false,
  onSuccessLogin,
  apiFetch,
}) => {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          phone: phone.trim(),
          password,
          totpCode: totpCode.trim() || undefined,
        }),
      });
      if (res.mfaRequired) {
        setMfaRequired(true);
      } else if (res.authenticated) {
        await onSuccessLogin(res);
        if (onClose) onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Неверный номер телефона или пароль');
    } finally {
      setLoading(false);
    }
  };

  const cardContent = (
    <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-6 sm:p-8 shadow-xs">
      <div className="flex items-center justify-between pb-5 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
            <Shield className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-900 leading-tight">
              Вход в приложение
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">РассрочкаПро</p>
          </div>
        </div>
        {!fullScreen && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg"
            aria-label="Закрыть"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-5 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 font-medium"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleLogin} className="mt-5 space-y-4">
        <div>
          <label
            htmlFor="login-phone-input"
            className="block text-xs font-medium text-slate-700 mb-1.5"
          >
            Номер телефона
          </label>
          <input
            id="login-phone-input"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+7 ___ ___-__-__"
            disabled={loading}
            className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900 disabled:bg-slate-50 disabled:text-slate-500"
            required
          />
        </div>

        <div>
          <label
            htmlFor="login-password-input"
            className="block text-xs font-medium text-slate-700 mb-1.5"
          >
            Пароль
          </label>
          <div className="relative">
            <input
              id="login-password-input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Введите пароль"
              disabled={loading}
              className="w-full pl-3.5 pr-10 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900 disabled:bg-slate-50 disabled:text-slate-500"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              disabled={loading}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 rounded"
              aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {mfaRequired && (
          <div>
            <label
              htmlFor="login-totp-input"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              Код двухфакторной защиты (TOTP, 6 цифр)
            </label>
            <input
              id="login-totp-input"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder="000000"
              disabled={loading}
              className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
              required
            />
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Проверка...</span>
            </>
          ) : (
            <span>Войти</span>
          )}
        </button>
      </form>
    </div>
  );

  if (fullScreen) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8FAFC] text-[#0F172A] p-4">
        {cardContent}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      {cardContent}
    </div>
  );
};
