import { useEffect, useRef } from "react";
import { useMotionValue, useReducedMotion, useSpring } from "motion/react";

/**
 * A calm count-up for dashboard numbers (motion.dev spring, about half a
 * second) — a micro-interaction, not spectacle. The final value is rendered
 * as the initial text so a frame with JS still settling reads correctly, and
 * the roll is skipped entirely when the OS asks for reduced motion.
 */
export function AnimatedNumber({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const motionValue = useMotionValue(0);
  const spring = useSpring(motionValue, { stiffness: 200, damping: 30 });

  useEffect(() => {
    if (reduced) {
      spring.jump(value);
    } else {
      motionValue.set(value);
    }
  }, [motionValue, spring, reduced, value]);

  useEffect(
    () =>
      spring.on("change", (latest) => {
        if (ref.current) ref.current.textContent = String(Math.round(latest));
      }),
    [spring],
  );

  return <span ref={ref}>{value}</span>;
}
