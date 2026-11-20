import type { FC, CSSProperties } from 'react';

interface ProviderIconProps {
  providerId: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Renders provider identity marks as monochrome inline SVGs.
 * Unknown providers fall back to a first-letter mark with the same treatment.
 */
export const ProviderIcon: FC<ProviderIconProps> = ({
  providerId,
  size = 20,
  className,
  style,
}) => {
  const svgProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    className,
    style: {
      filter: 'grayscale(1) contrast(1.35)',
      ...style,
    },
    'aria-hidden': true as const,
  };

  switch (providerId) {
    case 'snaglet-local':
    case 'local-onnx':
      // On-device Snaglet runtimes (local reranker / embedder). Not a
      // third-party brand, so instead of a colored badge or the seed
      // row's 🏠 emoji we render a neutral monochrome "home" mark that
      // inherits the surrounding text color — signaling "runs on this
      // machine" while matching the app's line-icon language.
      return (
        <svg
          {...svgProps}
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.5 11.5 12 5l8.5 6.5" />
          <path d="M5.5 10v9.5h13V10" />
          <path d="M10 19.5V14h4v5.5" />
        </svg>
      );

    case 'anthropic':
      // Anthropic "A" mark
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#D97706" />
          <path
            d="M13.928 5.5h2.784L21 18.5h-2.766l-.852-2.67H12.39l-.858 2.67H8.82l4.26-13h.848zM16.62 13.78l-1.86-5.816h-.048l-1.86 5.816h3.768z"
            fill="#fff"
          />
          <path d="M3 18.5h2.784L9.984 5.5H7.2L3 18.5z" fill="#fff" />
        </svg>
      );

    case 'openai':
    case 'codex':
      // OpenAI hexagonal knot
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect
            width="24"
            height="24"
            rx="4"
            fill={providerId === 'codex' ? '#1a1a2e' : '#10a37f'}
          />
          <path
            d="M18.8 10.58a3.42 3.42 0 0 0-.29-2.82 3.46 3.46 0 0 0-3.73-1.66A3.43 3.43 0 0 0 12.2 4.5a3.46 3.46 0 0 0-3.3 2.4 3.42 3.42 0 0 0-2.29 1.66 3.46 3.46 0 0 0 .43 4.06 3.42 3.42 0 0 0 .3 2.82 3.46 3.46 0 0 0 3.72 1.66 3.43 3.43 0 0 0 2.58 1.55 3.46 3.46 0 0 0 3.3-2.4 3.42 3.42 0 0 0 2.3-1.66 3.46 3.46 0 0 0-.44-4.06zm-5.14 7.56a2.58 2.58 0 0 1-1.66-.6l.08-.05 2.77-1.6a.45.45 0 0 0 .23-.4v-3.9l1.17.68a.04.04 0 0 1 .02.03v3.24a2.6 2.6 0 0 1-2.6 2.6zm-5.58-2.38a2.58 2.58 0 0 1-.31-1.74l.08.05 2.77 1.6a.45.45 0 0 0 .45 0l3.38-1.95v1.35a.04.04 0 0 1-.02.04l-2.8 1.61a2.6 2.6 0 0 1-3.55-.96zm-.73-6.04a2.58 2.58 0 0 1 1.35-1.14v3.3a.45.45 0 0 0 .23.39l3.38 1.95-1.17.68a.04.04 0 0 1-.04 0l-2.8-1.61a2.6 2.6 0 0 1-.95-3.56zm9.56 2.22L13.53 10l1.17-.68a.04.04 0 0 1 .04 0l2.8 1.62a2.6 2.6 0 0 1-.4 4.7v-3.3a.45.45 0 0 0-.23-.4zm1.16-1.75-.08-.05-2.77-1.6a.45.45 0 0 0-.45 0l-3.38 1.95V9.14a.04.04 0 0 1 .02-.04l2.8-1.6a2.6 2.6 0 0 1 3.86 2.7zM10.3 12.9l-1.17-.68a.04.04 0 0 1-.02-.03V8.95a2.6 2.6 0 0 1 4.26-2l-.08.05-2.77 1.6a.45.45 0 0 0-.23.4v3.9zm.64-1.37 1.5-.87 1.52.87v1.75l-1.51.87-1.51-.87V11.53z"
            fill="#fff"
          />
        </svg>
      );

    case 'google':
      // Google "G" mark
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#4285F4" />
          <path
            d="M18.64 12.2c0-.63-.06-1.25-.16-1.84H12v3.49h3.72a3.18 3.18 0 0 1-1.38 2.09v1.74h2.24c1.31-1.2 2.06-2.98 2.06-5.48z"
            fill="#fff"
          />
          <path
            d="M12 19c1.87 0 3.43-.62 4.58-1.68l-2.24-1.74c-.62.42-1.41.66-2.34.66-1.8 0-3.33-1.22-3.87-2.85H5.82v1.79A6.96 6.96 0 0 0 12 19z"
            fill="#fff"
            fillOpacity="0.9"
          />
          <path
            d="M8.13 13.39a4.18 4.18 0 0 1 0-2.78V8.82H5.82a7 7 0 0 0 0 6.36l2.31-1.79z"
            fill="#fff"
            fillOpacity="0.8"
          />
          <path
            d="M12 7.76c1.02 0 1.93.35 2.65 1.04l1.99-1.99A6.23 6.23 0 0 0 12 5a6.96 6.96 0 0 0-6.18 3.82l2.31 1.79C8.67 8.98 10.2 7.76 12 7.76z"
            fill="#fff"
            fillOpacity="0.7"
          />
        </svg>
      );

    case 'mistral':
      // Mistral AI stylized "M"
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#7C3AED" />
          <rect x="4" y="5" width="4" height="4" fill="#F59E0B" />
          <rect x="16" y="5" width="4" height="4" fill="#F59E0B" />
          <rect x="4" y="9" width="4" height="4" fill="#000" fillOpacity="0.3" />
          <rect x="8" y="9" width="4" height="4" fill="#F59E0B" />
          <rect x="12" y="9" width="4" height="4" fill="#000" fillOpacity="0.3" />
          <rect x="16" y="9" width="4" height="4" fill="#F59E0B" />
          <rect x="4" y="13" width="4" height="4" fill="#F59E0B" />
          <rect x="12" y="13" width="4" height="4" fill="#F59E0B" />
          <rect x="4" y="17" width="4" height="2" fill="#F59E0B" />
          <rect x="8" y="15" width="4" height="4" fill="#000" fillOpacity="0.3" />
          <rect x="16" y="13" width="4" height="4" fill="#000" fillOpacity="0.3" />
          <rect x="16" y="17" width="4" height="2" fill="#F59E0B" />
        </svg>
      );

    case 'together':
      // Together AI four-square mark
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#0F6FFF" />
          <rect x="5" y="5" width="6" height="6" rx="1.5" fill="#fff" />
          <rect x="13" y="5" width="6" height="6" rx="1.5" fill="#fff" fillOpacity="0.55" />
          <rect x="5" y="13" width="6" height="6" rx="1.5" fill="#fff" fillOpacity="0.55" />
          <rect x="13" y="13" width="6" height="6" rx="1.5" fill="#fff" fillOpacity="0.85" />
        </svg>
      );

    case 'lm-studio':
      // LM Studio wordmark initials
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#4F46E5" />
          <text
            x="12"
            y="16"
            textAnchor="middle"
            fill="#fff"
            fontSize="9"
            fontFamily="system-ui, sans-serif"
            fontWeight="700"
          >
            LM
          </text>
        </svg>
      );

    case 'ollama':
      // Ollama llama head
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#1a1a1a" />
          <rect x="8" y="4.5" width="2" height="4" rx="1" fill="#fff" />
          <rect x="14" y="4.5" width="2" height="4" rx="1" fill="#fff" />
          <path
            d="M12 7c-3 0-5 2.2-5 5.2 0 1.6.6 3 1.6 3.9-.3.7-.4 1.5-.3 2.4h1.6c-.1-.7 0-1.4.3-1.9.55.25 1.2.4 1.8.4s1.25-.15 1.8-.4c.3.5.4 1.2.3 1.9h1.6c.1-.9 0-1.7-.3-2.4 1-.9 1.6-2.3 1.6-3.9C17 9.2 15 7 12 7z"
            fill="#fff"
          />
          <circle cx="10.2" cy="11.8" r="0.9" fill="#1a1a1a" />
          <circle cx="13.8" cy="11.8" r="0.9" fill="#1a1a1a" />
        </svg>
      );

    case 'copilot':
      // GitHub Copilot logo
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#1F2328" />
          <path
            d="M12 5C8.5 5 6 7.5 6 10.5c0 1.8 1 3.4 2.4 4.3V17a1 1 0 0 0 1 1h5.2a1 1 0 0 0 1-1v-2.2C17 13.9 18 12.3 18 10.5 18 7.5 15.5 5 12 5zm-2.2 11.5v-1h4.4v1H9.8zm4.8-3.1-.4.3V15h-4.4v-1.3l-.4-.3C8.6 12.7 8 11.7 8 10.5 8 8.6 9.8 7 12 7s4 1.6 4 3.5c0 1.2-.6 2.2-1.4 2.9z"
            fill="#fff"
          />
          <circle cx="10.2" cy="10.5" r="1" fill="#fff" />
          <circle cx="13.8" cy="10.5" r="1" fill="#fff" />
        </svg>
      );

    case 'deepseek':
      // DeepSeek whale mark
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#4D6BFE" />
          <path
            d="M4.5 11.2c2.2-2.9 5.2-4 8.3-3.9 1.5.05 3 .5 4.2 1.4-.7.25-1.15.9-1.15 1.75 0 .5.18.95.48 1.28-1.05.86-2.5 1.4-4.05 1.5l.25 1.85-1.85-1.2c-1.5-.05-2.9-.6-3.9-1.5l-2.4 2.02c-.35-1.45-.32-2.9-.01-4.68z"
            fill="#fff"
          />
          <circle cx="15.7" cy="10.35" r="0.7" fill="#4D6BFE" />
        </svg>
      );

    case 'xai':
      // xAI (Grok) — angular slashed-X mark
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#000" />
          <path
            d="M6 5.5h2.6l4 5.6-1.55 2.05L6 5.5zm9.4 0H18l-4.35 5.75L18 18.5h-2.6l-3.05-4.35L15.4 5.5zM6 18.5l4.55-6.05 1.55 2.15L9.1 18.5H6z"
            fill="#fff"
          />
        </svg>
      );

    case 'apple-on-device':
      // Apple mark — on-device, so monochrome (matches the 'snaglet-local' /
      // 'local-onnx' "runs on this machine" treatment above) rather than a
      // brand-color badge.
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#1a1a1a" />
          <path
            d="M15.4 6.2c.05.9-.28 1.72-.86 2.36-.63.7-1.5 1.14-2.36 1.07-.1-.87.32-1.78.87-2.35.6-.66 1.6-1.13 2.35-1.08zM17.9 17.4c-.47.7-.97 1.4-1.75 1.42-.76.02-1-.44-1.87-.44-.87 0-1.14.43-1.86.46-.75.03-1.32-.75-1.8-1.45-.98-1.42-1.73-4.02-.72-5.77.5-.87 1.4-1.42 2.37-1.43.74-.02 1.44.5 1.9.5.44 0 1.3-.62 2.2-.53.37.02 1.42.15 2.1 1.12-.05.03-1.25.73-1.24 2.18.02 1.73 1.52 2.31 1.54 2.32-.02.05-.24.83-.79 1.62z"
            fill="#fff"
          />
        </svg>
      );

    case 'meta':
      // Meta infinity loop
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#0668E1" />
          <path
            d="M7.4 9.2c.7-1.1 1.5-1.7 2.4-1.7 1.3 0 2.1 1.1 2.8 2.5l.4.8c.6 1.2 1.1 2.1 1.9 2.1.6 0 1.2-.6 1.6-1.4.3-.6.4-1.2.4-1.7 0-2-1-3.3-2.8-3.3-1.3 0-2.3.8-3.2 2l-.5.7-.5-.7c-.8-1.1-1.7-2-3.2-2C4.7 6.5 3 8.5 3 11.8c0 1.6.5 3.2 1.3 4.5.8 1.3 1.8 2.2 2.8 2.2 1.3 0 2.1-1.1 2.8-2.5l.4-.8c.6-1.2 1.1-2.1 1.9-2.1.6 0 1.2.6 1.6 1.4.3.6.4 1.2.4 1.7 0 2-1 3.3-2.8 3.3-1 0-1.8-.4-2.5-1.2"
            stroke="#fff"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );

    default: {
      // Fallback: colored circle with first letter
      const letter = providerId.charAt(0).toUpperCase();
      return (
        <svg {...svgProps} viewBox="0 0 24 24">
          <rect width="24" height="24" rx="4" fill="#555" />
          <text
            x="12"
            y="16.5"
            textAnchor="middle"
            fill="#fff"
            fontSize="13"
            fontWeight="600"
            fontFamily="system-ui, sans-serif"
          >
            {letter}
          </text>
        </svg>
      );
    }
  }
};
