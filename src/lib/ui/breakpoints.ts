// P3-4.1：斷點只有兩個——`sm`（640，表↔卡切換）同 `lg`（1024，外殼：左欄↔漢堡抽屜）。
// Tailwind class 用 `sm:`／`lg:`；JS（matchMedia／innerWidth）一律用呢度嘅常數，唔好再寫 639／767／1023 呢啲數。
export const SM_PX = 640;
export const LG_PX = 1024;
/** < sm（手機直向：表變卡、RosterEditor compact）。 */
export const MQ_BELOW_SM = `(max-width: ${SM_PX - 1}px)`;
/** < lg（外殼係手機：漢堡抽屜、全屏 dialog、AI 面板 overlay）。 */
export const MQ_BELOW_LG = `(max-width: ${LG_PX - 1}px)`;
