import type { Device } from "./types";

/** R2 keys of what a CRO capture stores per page: the screenshots (`top` is the crop of the top of the page) and the page text. */
export const shotKey = (auditId: string, index: number, device: Device, top = false) => `cro/${auditId}/${index}-${device}${top ? "-top" : ""}.jpg`;
export const textKey = (auditId: string, index: number) => `cro/${auditId}/${index}.txt`;
