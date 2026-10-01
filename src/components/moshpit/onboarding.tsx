import { useState } from "react";
import {
  ArrowRight,
  Check,
  Monitor,
  Smartphone,
  Terminal,
  GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MoshpitMark } from "@/components/moshpit/mark";
import { useMoshpitStore } from "@/lib/moshpit/store";

const STEPS = [
  {
    kicker: "01",
    title: "A little space. For your whole herd.",
    body: "Your agents already run on your machine. Bring them together here. Follow the work, answer a question, and let them get back to it.",
  },
  {
    kicker: "02",
    title: "Your machines. A familiar conversation.",
    body: "Connect your herdr bridge through Tailscale. Chat with Claude Code, Codex, and the rest of your herd, with their terminal one tap away.",
  },
  {
    kicker: "03",
    title: "Pick up wherever you are.",
    body: "Open moshpit on your phone, tablet, or computer. Add it to your Home Screen or install it from your browser. Your agents stay on your machine.",
  },
];

export function Onboarding() {
  const complete = useMoshpitStore((s) => s.completeOnboarding);
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="h-dvh overflow-y-auto bg-bg">
      <div className="mx-auto grid min-h-dvh max-w-[1240px] grid-cols-1 gap-10 px-6 py-8 md:px-12 lg:grid-cols-2 lg:items-center lg:gap-20 lg:py-16">
        <div className="flex flex-col">
          <div className="mb-16 flex items-center gap-2.5 lg:mb-20">
            <MoshpitMark className="size-9" />
            <span className="text-2xl font-semibold tracking-tight">
              moshpit<span className="text-accent">.</span>
            </span>
            <span className="ml-2 border-l border-border pl-4 text-xs text-muted">
              at home with herdr
            </span>
          </div>
          <div key={step} className="stagger-in">
            <p className="text-2xs font-medium uppercase tracking-[0.2em] text-accent">
              A place for your agents
            </p>
            <h1 className="welcome-title mt-5 max-w-lg text-balance text-[clamp(2.8rem,5vw,4.4rem)] leading-[1.06]">
              {current.title}
            </h1>
            <p className="mt-6 max-w-md text-base leading-7 text-muted">
              {current.body}
            </p>
          </div>

          <div className="mt-10 flex max-w-sm flex-col gap-4">
            <div
              className="mb-3 flex gap-1.5"
              aria-label={`Step ${step + 1} of ${STEPS.length}`}
            >
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  className={
                    i === step
                      ? "h-1 w-6 rounded-full bg-accent"
                      : "h-1 w-3 rounded-full bg-border-strong"
                  }
                />
              ))}
            </div>
            <Button
              size="lg"
              className="w-full"
              onClick={() => (last ? complete() : setStep((s) => s + 1))}
            >
              {last ? "Open moshpit" : "Next"}
              <ArrowRight className="size-4" />
            </Button>
            {step > 0 ? (
              <button
                type="button"
                className="h-11 text-sm text-muted"
                onClick={() => setStep((s) => s - 1)}
              >
                Back
              </button>
            ) : (
              <button
                type="button"
                className="h-11 text-sm text-muted"
                onClick={complete}
              >
                Skip
              </button>
            )}
          </div>
          <p className="mt-8 text-xs text-subtle">
            Open source. Built for your own machines.
          </p>
        </div>
        <div
          className="welcome-art relative hidden min-h-[520px] items-center justify-center rounded-[32px] border border-border bg-surface/50 p-8 lg:flex"
          aria-hidden="true"
        >
          <div className="w-full max-w-sm rounded-2xl border border-border bg-bg p-5 shadow-xl shadow-black/5">
            <div className="mb-6 flex items-center gap-2 text-sm font-medium">
              <MoshpitMark className="size-6" /> Your herd{" "}
              <span className="ml-auto rounded-full bg-working/10 px-2.5 py-1 text-2xs text-working">
                3 agents
              </span>
            </div>
            <div className="rounded-xl border border-blocked/25 bg-blocked/5 p-4">
              <p className="text-2xs text-blocked">Needs your attention</p>
              <p className="mt-2 font-medium">One last thing before I ship.</p>
              <p className="mt-1 text-sm leading-6 text-muted">
                The migration is ready. Shall I run it?
              </p>
              <div className="mt-4 flex items-center gap-2 text-2xs text-muted">
                <Terminal className="size-3.5" /> Codex <span>·</span> web /
                database
              </div>
            </div>
            <div className="my-4 ml-10 rounded-2xl rounded-br-sm bg-surface px-4 py-3 text-sm">
              Looks good. Go ahead.
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border p-4">
              <span className="flex size-8 items-center justify-center rounded-full bg-working/10 text-working">
                <Check className="size-4" />
              </span>
              <div>
                <p className="text-sm font-medium">Back to work.</p>
                <p className="mt-0.5 text-xs text-muted">
                  Your herd has it from here.
                </p>
              </div>
            </div>
            <div className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-2xs text-muted">
              <GitBranch className="size-3.5" /> Your code stays on your
              machine.
            </div>
          </div>
          <div className="absolute bottom-7 flex items-center gap-2 text-xs text-muted">
            <Smartphone className="size-4" />
            <Monitor className="size-4" />
            <span className="ml-1">One workspace. Any screen.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
