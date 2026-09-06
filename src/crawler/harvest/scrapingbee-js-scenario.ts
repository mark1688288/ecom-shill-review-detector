// SPDX-License-Identifier: GPL-3.0-only
import { HarvestUsageError } from './errors.js';

export const HKTVMALL_SB_REVIEW_TAB_CSS = '[data-tab=reviewTab]';
export const HKTVMALL_SB_WRAPPER_CSS = 'div.product-review-wrapper';
export const SCRAPINGBEE_PAGER_WAIT_MS = 7_000;
export const SCRAPINGBEE_JS_SCENARIO_MAX_MS = 40_000;
export const SCRAPINGBEE_MAX_HREF_CHARS = 6144;
export const SCRAPINGBEE_TIMEOUT_MS_MIN = 1_000;
export const SCRAPINGBEE_TIMEOUT_MS_MAX = 140_000;

export type HktvmallReviewJsScenario = {
  strict: true;
  instructions: unknown[];
};

/**
 * Pager evaluate as a string constant so tsc (lib ES2022 / types node) never sees `document`.
 * Inserts pageIndex as a decimal integer. The resulting source must not contain `\`.
 */
function hktvmallPagerEvaluateSource(pageIndex: number): string {
  return `var s=null;
var totals=document.getElementsByClassName('total');
for(var i=0;i<totals.length;i++){
  var t=totals[i];
  var txt=t.textContent||'';
  if(txt.indexOf('共')===-1||txt.indexOf('頁')===-1) continue;
  var root=t.parentElement;
  while(root&&!s){
    var cand=root.querySelector('select');
    var btn=root.querySelector('a.next-btn');
    if(cand&&btn) s=cand;
    else root=root.parentElement;
  }
  if(s) break;
}
if(s){
  s.value='${String(pageIndex)}';
  s.dispatchEvent(new Event('change',{bubbles:true}));
}`;
}

export function buildHktvmallReviewJsScenario(pageIndex: number): HktvmallReviewJsScenario {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new HarvestUsageError('js_scenario pageIndex must be an integer >= 0');
  }
  const evaluate = hktvmallPagerEvaluateSource(pageIndex);
  if (evaluate.includes('\\')) {
    throw new HarvestUsageError('js_scenario evaluate must not contain backslash');
  }
  return {
    strict: true,
    instructions: [
      { wait_for: HKTVMALL_SB_REVIEW_TAB_CSS },
      { click: HKTVMALL_SB_REVIEW_TAB_CSS },
      { wait_for: HKTVMALL_SB_WRAPPER_CSS },
      { evaluate },
      { wait: SCRAPINGBEE_PAGER_WAIT_MS },
      { wait_for: HKTVMALL_SB_WRAPPER_CSS },
    ],
  };
}
