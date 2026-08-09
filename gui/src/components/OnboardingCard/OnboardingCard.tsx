import { OnboardingModes } from "core/protocol/core";
import { useEffect, useMemo } from "react";
import { useAppSelector } from "../../redux/hooks";
import { getLocalStorage, setLocalStorage } from "../../util/localStorage";
import { ReusableCard } from "../ReusableCard";
import { OnboardingCardTabs } from "./components/OnboardingCardTabs";
import { OnboardingLocalTab } from "./components/OnboardingLocalTab";
import { OnboardingProvidersTab } from "./components/OnboardingProvidersTab";
import { useOnboardingCard } from "./hooks/useOnboardingCard";

export interface OnboardingCardState {
  show?: boolean;
  activeTab?: OnboardingModes;
}

interface OnboardingCardProps {
  isDialog?: boolean;
}

export function OnboardingCard({ isDialog }: OnboardingCardProps) {
  const { activeTab, close, setActiveTab } = useOnboardingCard();
  const config = useAppSelector((store) => store.config.config);

  const shouldHideProviderPoolInputs = useMemo(() => {
    const modelsByRole = config?.modelsByRole;
    if (!modelsByRole) {
      return false;
    }

    for (const roleModels of Object.values(modelsByRole)) {
      for (const model of roleModels ?? []) {
        if (model?.providerName !== "ai-studio") {
          continue;
        }
        const hideFlag =
          model.requestOptions?.extraBodyProperties?.ai_studio_hide_pool_key_inputs;
        if (hideFlag === true) {
          return true;
        }
      }
    }

    return false;
  }, [config]);

  if (getLocalStorage("onboardingStatus") === undefined) {
    setLocalStorage("onboardingStatus", "Started");
  }

  useEffect(() => {
    if (!activeTab) {
      setActiveTab(
        shouldHideProviderPoolInputs
          ? OnboardingModes.LOCAL
          : OnboardingModes.API_KEY,
      );
    }
  }, [activeTab, setActiveTab, shouldHideProviderPoolInputs]);

  useEffect(() => {
    if (shouldHideProviderPoolInputs && activeTab === OnboardingModes.API_KEY) {
      setActiveTab(OnboardingModes.LOCAL);
    }
  }, [activeTab, setActiveTab, shouldHideProviderPoolInputs]);

  function renderTabContent() {
    switch (activeTab) {
      case OnboardingModes.API_KEY:
        if (shouldHideProviderPoolInputs) {
          return <OnboardingLocalTab />;
        }
        return <OnboardingProvidersTab />;
      case OnboardingModes.LOCAL:
        return <OnboardingLocalTab />;
      default:
        if (shouldHideProviderPoolInputs) {
          return <OnboardingLocalTab />;
        }
        return <OnboardingProvidersTab />;
    }
  }

  const currentTab = activeTab || OnboardingModes.API_KEY;

  return (
    <ReusableCard
      showCloseButton={!isDialog && !!config.modelsByRole.chat.length}
      onClose={close}
      testId="onboarding-card"
    >
      <OnboardingCardTabs
        activeTab={currentTab}
        onTabClick={setActiveTab}
        hideApiKeyTab={shouldHideProviderPoolInputs}
      />
      {renderTabContent()}
    </ReusableCard>
  );
}
