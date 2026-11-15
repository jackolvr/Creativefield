/** Where Swap a thing looks for the thing in its clip, as a share of the clip's length (DOC-2191): the first frame
 *  first, then a few more only if the thing is not in it. One frame is read each time, never the whole clip. */
export const FRAME_POSITIONS = [0, 0.25, 0.5, 0.75] as const;
