import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

interface BannerLinkProps {
  url: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}

/** In-app paths stay in the SPA; anything else opens in a new tab. */
export default function BannerLink({ url, className, onClick, children }: BannerLinkProps) {
  if (url.startsWith('/')) {
    return (
      <RouterLink to={url} className={className} onClick={onClick}>
        {children}
      </RouterLink>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className} onClick={onClick}>
      {children}
    </a>
  );
}
