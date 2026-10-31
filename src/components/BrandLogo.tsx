import React, { useId } from 'react';

interface BrandLogoProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<BrandLogoProps['size']>, string> = {
  xs: 'w-6 h-6',
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-14 h-14',
  xl: 'w-20 h-20',
};

export const BrandLogo: React.FC<BrandLogoProps> = ({ size = 'md', className = '' }) => {
  const uid = useId().replace(/:/g, '');

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="70 40 390 365"
      fill="none"
      role="img"
      aria-label="Логотип РассрочкаПро"
      className={`${SIZE_CLASSES[size]} shrink-0 select-none ${className}`}
    >
      <defs>
        <linearGradient
          id={`pOuterGrad-${uid}`}
          x1="110"
          y1="60"
          x2="400"
          y2="410"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#0A3D91" />
          <stop offset="45%" stopColor="#0E56C8" />
          <stop offset="100%" stopColor="#051E4D" />
        </linearGradient>

        <linearGradient
          id={`pHighlightGrad-${uid}`}
          x1="150"
          y1="64"
          x2="410"
          y2="260"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#1D7AFC" />
          <stop offset="55%" stopColor="#0F5AD1" />
          <stop offset="100%" stopColor="#072B6C" />
        </linearGradient>

        <linearGradient
          id={`pInnerBevel-${uid}`}
          x1="175"
          y1="105"
          x2="290"
          y2="360"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#031538" />
          <stop offset="100%" stopColor="#082C6C" />
        </linearGradient>

        <linearGradient id={`barBlue1-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#48B2FF" />
          <stop offset="100%" stopColor="#1371E6" />
        </linearGradient>

        <linearGradient id={`barBlue2-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2B95FF" />
          <stop offset="100%" stopColor="#0B53C1" />
        </linearGradient>

        <linearGradient id={`barGreen3-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34D399" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>

        <linearGradient
          id={`bagMainGrad-${uid}`}
          x1="255"
          y1="240"
          x2="395"
          y2="395"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#34D399" />
          <stop offset="45%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#047857" />
        </linearGradient>

        <linearGradient
          id={`bagSideGrad-${uid}`}
          x1="245"
          y1="245"
          x2="285"
          y2="375"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#6EE7B7" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>

        <linearGradient
          id={`swooshGrad-${uid}`}
          x1="100"
          y1="205"
          x2="355"
          y2="385"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#4ADE80" />
          <stop offset="45%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#065F46" />
        </linearGradient>

        <linearGradient
          id={`coinGrad-${uid}`}
          x1="330"
          y1="275"
          x2="435"
          y2="395"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#10B981" />
          <stop offset="60%" stopColor="#059669" />
          <stop offset="100%" stopColor="#064E3B" />
        </linearGradient>
      </defs>

      {/* 1. MAIN LETTER "Р" OUTER BODY */}
      <path
        d="M136 86C136 71.6406 147.641 60 162 60H286C355.588 60 408 106.412 408 168C408 229.588 355.588 276 286 276H226V356C226 369.255 215.255 380 202 380H160C146.745 380 136 369.255 136 356V86Z"
        fill={`url(#pOuterGrad-${uid})`}
      />

      {/* Glossy Outer Right Arc Highlight on "Р" */}
      <path
        d="M210 60H286C355.588 60 408 106.412 408 168C408 216.5 375.5 256.5 326 270.5C362 248 380 212 380 168C380 117.5 339.5 82 282 82H210V60Z"
        fill={`url(#pHighlightGrad-${uid})`}
      />

      {/* Inner Recessed 3D Channel of "Р" */}
      <path
        d="M182 102C182 96.4772 186.477 92 192 92H284C334.81 92 372 124.69 372 168C372 211.31 334.81 244 284 244H214C202.954 244 194 252.954 194 264V368H182V102Z"
        fill={`url(#pInnerBevel-${uid})`}
      />

      {/* White Counter Inside "Р" */}
      <path
        d="M202 126C202 121.582 205.582 118 210 118H282C322.869 118 352 139.49 352 168C352 196.51 322.869 218 282 218H210C205.582 218 202 214.418 202 210V126Z"
        fill="#FFFFFF"
      />

      {/* 2. RISING FINANCIAL BARS & GROWTH ARROW INSIDE THE "Р" COUNTER */}
      <rect x="248" y="174" width="24" height="32" rx="5" fill={`url(#barBlue1-${uid})`} />
      <rect x="279" y="154" width="24" height="52" rx="5" fill={`url(#barBlue2-${uid})`} />
      <rect x="310" y="138" width="22" height="68" rx="5" fill={`url(#barGreen3-${uid})`} />
      <path d="M321 122L333 138H309L321 122Z" fill="#10B981" />

      {/* 3. SHOPPING BAG IN FOREGROUND */}
      <path
        d="M256 250C258.5 239.5 267.8 232 278.6 232H371.4C382.2 232 391.5 239.5 394 250L412 346C414.5 359 404.5 371 391.2 371H258.8C245.5 371 235.5 359 238 346L256 250Z"
        fill="#FFFFFF"
      />
      <path
        d="M264 254C266 245.5 273.5 240 282.2 240H300L282 362H260C250.5 362 243.5 353 245.5 343.5L264 254Z"
        fill={`url(#bagSideGrad-${uid})`}
      />
      <path
        d="M282 240H368C377.2 240 385.1 246.4 387 255.4L404 343.5C406 353 398.8 362 389.2 362H268L282 240Z"
        fill={`url(#bagMainGrad-${uid})`}
      />
      <path
        d="M303 255V236C303 219.984 315.984 207 332 207C348.016 207 361 219.984 361 236V255"
        stroke="#FFFFFF"
        strokeWidth="11"
        strokeLinecap="round"
      />
      <circle cx="303" cy="256" r="5.5" fill="#FFFFFF" />
      <circle cx="361" cy="256" r="5.5" fill="#FFFFFF" />

      {/* 4. SWEEPING EMERALD SWOOSH RIBBON */}
      <path
        d="M126 196C94 254 114 316 192 346C240 364 296 371 344 371C284 358 214 335 170 301C128 269 118 232 126 196Z"
        stroke="#FFFFFF"
        strokeWidth="14"
        strokeLinejoin="round"
      />
      <path
        d="M126 196C92 256 112 320 194 350C246 369 306 375 352 373C288 360 214 336 168 300C128 268 117 231 126 196Z"
        fill={`url(#swooshGrad-${uid})`}
      />

      {/* 5. RUBLE COIN BADGE */}
      <circle cx="378" cy="332" r="64" fill="#FFFFFF" />
      <circle cx="378" cy="332" r="54" fill={`url(#coinGrad-${uid})`} />
      <circle cx="378" cy="332" r="50" stroke="#6EE7B7" strokeOpacity="0.28" strokeWidth="2" />

      {/* Russian Ruble Symbol (₽) */}
      <path
        d="M360 298C360 295.239 362.239 293 365 293H384C397.807 293 408 301.954 408 314.5C408 327.046 397.807 336 384 336H371V345H393C395.761 345 398 347.239 398 350C398 352.761 395.761 355 393 355H371V366C371 368.761 368.761 371 366 371H365C362.239 371 360 368.761 360 366V355H353C350.239 355 348 352.761 348 350C348 347.239 350.239 345 353 345H360V336H353C350.239 336 348 333.761 348 331C348 328.239 350.239 326 353 326H360V298ZM371 303V326H383.5C391.232 326 396.5 321.448 396.5 314.5C396.5 307.552 391.232 303 383.5 303H371Z"
        fill="#FFFFFF"
      />
    </svg>
  );
};
