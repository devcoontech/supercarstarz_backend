import { forbidden } from '../../core/errors.js';

/** Staff roles allowed to record money, refund, and confirm or change charges. */
export const FINANCE_ROLES = ['owner', 'administrator', 'finance_manager'];

export const requireFinance = (req: any) => {
  if (!FINANCE_ROLES.includes(req.user.role)) throw forbidden('Only the owner, administrators and finance managers can change payments or charges');
};
