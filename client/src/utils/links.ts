import type { AnchorHTMLAttributes } from 'react';

type LinkAttributes = Pick<AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'>;

export const getLinkAttributes = (openNewTab?: boolean): LinkAttributes =>
  openNewTab === true ? { target: '_blank', rel: 'noopener noreferrer' } : { rel: 'noreferrer' };
