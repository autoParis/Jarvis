// Whether a key press in a message box sends the message. On a touch screen Enter is a line break and only the Send
// button sends. On a desktop Enter sends and Shift+Enter is a line break. daemon/enterkey.test.ts imports this.
export const enterSends = (e, touch = matchMedia('(pointer: coarse)').matches) => e.key === 'Enter' && !e.shiftKey && !touch;
