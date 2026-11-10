import { SettingsTabValues } from 'librechat-data-provider';
import type { SettingEntry } from './types';
import {
  SpeechToTextSwitch,
  LanguageSTTDropdown,
  AutoTranscribeAudioSwitch,
  AutoSendTextSelector,
} from '../SettingsTabs/Speech/STT';
import {
  TextToSpeechSwitch,
  VoiceDropdown,
  AutomaticPlaybackSwitch,
} from '../SettingsTabs/Speech/TTS';
import DisplayUsernameMessages from '../SettingsTabs/Account/DisplayUsernameMessages';
import ConversationModeSwitch from '../SettingsTabs/Speech/ConversationModeSwitch';
import EnableTwoFactorItem from '../SettingsTabs/Account/TwoFactorAuthentication';
import LangfuseConnection from '../SettingsTabs/Integrations/LangfuseConnection';
import ImportConversations from '../SettingsTabs/Data/ImportConversations';
import { ArchiveAllChats } from '../SettingsTabs/Data/ArchiveAllChats';
import { toggleControl, ThemeSetting, LangSetting } from './controls';
import BackupCodesItem from '../SettingsTabs/Account/BackupCodesItem';
import FontSizeSelector from '../SettingsTabs/Chat/FontSizeSelector';
import ChatTitleInTab from '../SettingsTabs/General/ChatTitleInTab';
import DuringRunAction from '../SettingsTabs/Chat/DuringRunAction';
import DeleteAccount from '../SettingsTabs/Account/DeleteAccount';
import StatefulWorkspaceDefault from './StatefulWorkspaceDefault';
import { ManageFiles } from '../SettingsTabs/Data/ManageFiles';
import { ClearChats } from '../SettingsTabs/Data/ClearChats';
import { TokenCredits, AutoRefill } from './BillingControls';
import AdminPanel from '../SettingsTabs/General/AdminPanel';
import SharedLinks from '../SettingsTabs/Data/SharedLinks';
import { EngineSTTSetting } from './SpeechControls';
import ProviderKeys from '../SettingsTabs/ProviderKeys';
import Avatar from '../SettingsTabs/Account/Avatar';
import ApiKeys from '../SettingsTabs/ApiKeys';
import MemoryToggle from './MemoryToggle';
import store from '~/store';

const { GENERAL, CHAT, SPEECH, DATA, ACCOUNT } = SettingsTabValues;

export const registry: SettingEntry[] = [
  // General · Appearance
  {
    id: 'theme',
    tab: GENERAL,
    section: 'appearance',
    labelKey: 'com_nav_theme',
    keywords: ['dark', 'light', 'appearance', 'color'],
    Component: ThemeSetting,
  },
  {
    id: 'language',
    tab: GENERAL,
    section: 'appearance',
    labelKey: 'com_nav_language',
    keywords: ['locale', 'translation'],
    Component: LangSetting,
  },
  {
    id: 'fontSize',
    tab: GENERAL,
    section: 'appearance',
    labelKey: 'com_nav_font_size',
    keywords: ['text', 'zoom'],
    Component: FontSizeSelector,
  },
  // General · Layout
  {
    id: 'maximizeChatSpace',
    tab: GENERAL,
    section: 'layout',
    labelKey: 'com_nav_maximize_chat_space',
    Component: toggleControl({
      stateAtom: store.maximizeChatSpace,
      localizationKey: 'com_nav_maximize_chat_space',
      switchId: 'maximizeChatSpace',
    }),
  },
  {
    id: 'chatTitleInTab',
    tab: GENERAL,
    section: 'layout',
    labelKey: 'com_nav_chat_title_in_tab',
    keywords: ['tab', 'title', 'browser', 'window'],
    Component: ChatTitleInTab,
  },
  // General · Accessibility
  {
    id: 'keepScreenAwake',
    tab: GENERAL,
    section: 'accessibility',
    labelKey: 'com_nav_keep_screen_awake',
    Component: toggleControl({
      stateAtom: store.keepScreenAwake,
      localizationKey: 'com_nav_keep_screen_awake',
      switchId: 'keepScreenAwake',
    }),
  },
  // General · Admin
  {
    id: 'adminPanel',
    tab: GENERAL,
    section: 'admin',
    labelKey: 'com_ui_admin_panel',
    keywords: ['admin', 'panel', 'dashboard'],
    Component: AdminPanel,
    show: (ctx) => ctx.adminPanelURL !== '',
  },

  // Chat · Sending
  {
    id: 'enterToSend',
    tab: CHAT,
    section: 'sending',
    labelKey: 'com_nav_enter_to_send',
    keywords: ['return', 'newline'],
    Component: toggleControl({
      stateAtom: store.enterToSend,
      localizationKey: 'com_nav_enter_to_send',
      switchId: 'enterToSend',
      hoverCardText: 'com_nav_info_enter_to_send',
    }),
  },
  {
    id: 'duringRunDefaultAction',
    tab: CHAT,
    section: 'sending',
    labelKey: 'com_nav_during_run_action',
    keywords: ['steer', 'queue', 'interrupt', 'generating'],
    Component: DuringRunAction,
  },
  {
    id: 'saveDrafts',
    tab: CHAT,
    section: 'sending',
    labelKey: 'com_nav_save_drafts',
    Component: toggleControl({
      stateAtom: store.saveDrafts,
      localizationKey: 'com_nav_save_drafts',
      switchId: 'saveDrafts',
      hoverCardText: 'com_nav_info_save_draft',
    }),
  },
  {
    id: 'pasteLongTextAsFile',
    tab: CHAT,
    section: 'sending',
    labelKey: 'com_nav_paste_long_text_as_file',
    keywords: ['paste', 'clipboard', 'attachment', 'file', 'text'],
    Component: toggleControl({
      stateAtom: store.pasteLongTextAsFile,
      localizationKey: 'com_nav_paste_long_text_as_file',
      switchId: 'pasteLongTextAsFile',
      hoverCardText: 'com_nav_info_paste_long_text_as_file',
    }),
  },
  // Chat · Commands
  {
    id: 'plusCommand',
    tab: CHAT,
    section: 'commands',
    labelKey: 'com_nav_plus_command_description',
    show: (ctx) => ctx.hasMultiConvo,
    Component: toggleControl({
      stateAtom: store.plusCommand,
      localizationKey: 'com_nav_plus_command_description',
      switchId: 'plusCommand',
    }),
  },
  {
    id: 'slashCommand',
    tab: CHAT,
    section: 'commands',
    labelKey: 'com_nav_slash_command_description',
    show: (ctx) => ctx.hasPrompts,
    Component: toggleControl({
      stateAtom: store.slashCommand,
      localizationKey: 'com_nav_slash_command_description',
      switchId: 'slashCommand',
    }),
  },
  // Chat · Messages
  {
    id: 'usernameDisplay',
    tab: CHAT,
    section: 'messages',
    labelKey: 'com_nav_user_name_display',
    keywords: ['username', 'name'],
    Component: DisplayUsernameMessages,
  },
  // Chat · Conversations
  {
    id: 'newChatSwitchToHistory',
    tab: CHAT,
    section: 'conversations',
    labelKey: 'com_nav_new_chat_switch_to_history',
    Component: toggleControl({
      stateAtom: store.newChatSwitchToHistory,
      localizationKey: 'com_nav_new_chat_switch_to_history',
      switchId: 'newChatSwitchToHistory',
    }),
  },
  {
    id: 'defaultTemporaryChat',
    tab: CHAT,
    section: 'conversations',
    labelKey: 'com_nav_default_temporary_chat',
    Component: toggleControl({
      stateAtom: store.defaultTemporaryChat,
      localizationKey: 'com_nav_default_temporary_chat',
      switchId: 'defaultTemporaryChat',
      hoverCardText: 'com_nav_info_default_temporary_chat',
    }),
  },
  // Chat · Prompts
  {
    id: 'autoSendPrompts',
    tab: CHAT,
    section: 'prompts',
    labelKey: 'com_nav_auto_send_prompts',
    Component: toggleControl({
      stateAtom: store.autoSendPrompts,
      localizationKey: 'com_nav_auto_send_prompts',
      switchId: 'autoSendPrompts',
      hoverCardText: 'com_nav_auto_send_prompts_desc',
    }),
  },

  // Speech · Speech-to-text
  {
    id: 'speechToText',
    tab: SPEECH,
    section: 'stt',
    labelKey: 'com_nav_speech_to_text',
    Component: SpeechToTextSwitch,
  },
  {
    id: 'engineSTT',
    tab: SPEECH,
    section: 'stt',
    labelKey: 'com_ui_settings_label_engine_stt',
    Component: EngineSTTSetting,
  },
  {
    id: 'languageSTT',
    tab: SPEECH,
    section: 'stt',
    labelKey: 'com_ui_settings_label_language_stt',
    Component: LanguageSTTDropdown,
  },
  {
    id: 'autoTranscribeAudio',
    tab: SPEECH,
    section: 'stt',
    labelKey: 'com_nav_auto_transcribe_audio',
    Component: AutoTranscribeAudioSwitch,
  },
  {
    id: 'autoSendText',
    tab: SPEECH,
    section: 'stt',
    labelKey: 'com_nav_auto_send_text',
    Component: AutoSendTextSelector,
  },
  // Speech · Text-to-speech
  {
    id: 'textToSpeech',
    tab: SPEECH,
    section: 'tts',
    labelKey: 'com_nav_text_to_speech',
    Component: TextToSpeechSwitch,
  },
  {
    id: 'voice',
    tab: SPEECH,
    section: 'tts',
    labelKey: 'com_ui_settings_label_voice',
    Component: VoiceDropdown,
  },
  {
    id: 'conversationMode',
    tab: SPEECH,
    section: 'tts',
    labelKey: 'com_ui_settings_label_conversation_mode',
    Component: ConversationModeSwitch,
  },
  {
    id: 'automaticPlayback',
    tab: SPEECH,
    section: 'tts',
    labelKey: 'com_nav_automatic_playback',
    Component: AutomaticPlaybackSwitch,
  },

  // Data controls · Memory
  {
    id: 'referenceSavedMemories',
    tab: DATA,
    section: 'memory',
    labelKey: 'com_ui_reference_saved_memories',
    keywords: ['memory', 'personalization'],
    show: (ctx) => ctx.hasMemoryOptOut,
    Component: MemoryToggle,
  },
  // Data controls · Code execution
  {
    id: 'defaultStatefulWorkspace',
    tab: DATA,
    section: 'codeExecution',
    labelKey: 'com_ui_default_stateful_workspace',
    keywords: ['agent', 'code', 'environment', 'sandbox', 'stateful', 'workspace'],
    show: (ctx) => ctx.hasStatefulCodeSessions,
    Component: StatefulWorkspaceDefault,
  },
  // Data controls · Your data
  {
    id: 'importConversations',
    tab: DATA,
    section: 'data',
    labelKey: 'com_ui_settings_label_import',
    Component: ImportConversations,
  },
  {
    id: 'sharedLinks',
    tab: DATA,
    section: 'data',
    labelKey: 'com_ui_settings_label_shared_links',
    Component: SharedLinks,
  },
  {
    id: 'manageFiles',
    tab: DATA,
    section: 'data',
    labelKey: 'com_ui_settings_label_manage_files',
    keywords: ['file', 'files', 'upload', 'uploads', 'storage', 'attachments'],
    Component: ManageFiles,
  },
  {
    id: 'archiveAllChats',
    tab: DATA,
    section: 'data',
    labelKey: 'com_ui_settings_label_archive_all_chats',
    keywords: ['archive', 'chats', 'conversations', 'bulk'],
    Component: ArchiveAllChats,
  },
  // Data controls · API keys
  {
    id: 'providerApiKeys',
    tab: DATA,
    section: 'apiKeys',
    labelKey: 'com_ui_settings_label_provider_api_keys',
    keywords: ['api', 'key', 'keys', 'provider', 'endpoint', 'credentials'],
    show: (ctx) => ctx.hasUserProvidedEndpoints,
    Component: ProviderKeys,
  },
  {
    id: 'agentApiKeys',
    tab: DATA,
    section: 'apiKeys',
    labelKey: 'com_ui_settings_label_agent_api_keys',
    show: (ctx) => ctx.hasRemoteAgents,
    Component: ApiKeys,
  },
  // Langfuse
  {
    id: 'langfuseConnection',
    tab: SettingsTabValues.LANGFUSE,
    section: 'langfuse',
    labelKey: 'com_ui_langfuse_title',
    keywords: ['langfuse', 'observability', 'tracing', 'telemetry', 'traces'],
    show: (ctx) => ctx.langfuseConnectionAccess,
    Component: LangfuseConnection,
  },
  // Data controls · Danger zone
  {
    id: 'clearChats',
    tab: DATA,
    section: 'danger',
    labelKey: 'com_ui_settings_label_clear_chats',
    Component: ClearChats,
  },

  // Account · Profile
  {
    id: 'avatar',
    tab: ACCOUNT,
    section: 'profile',
    labelKey: 'com_ui_settings_label_avatar',
    Component: Avatar,
  },
  // Account · Security
  {
    id: 'twoFactor',
    tab: ACCOUNT,
    section: 'security',
    labelKey: 'com_ui_settings_label_2fa',
    show: (ctx) => ctx.isLocalProvider,
    Component: EnableTwoFactorItem,
  },
  {
    id: 'backupCodes',
    tab: ACCOUNT,
    section: 'security',
    labelKey: 'com_ui_settings_label_backup_codes',
    show: (ctx) => ctx.isLocalProvider && ctx.twoFactorEnabled,
    Component: BackupCodesItem,
  },
  // Account · Billing
  {
    id: 'tokenCredits',
    tab: ACCOUNT,
    section: 'billing',
    labelKey: 'com_ui_settings_label_credits',
    show: (ctx) => ctx.balanceEnabled,
    Component: TokenCredits,
  },
  {
    id: 'autoRefill',
    tab: ACCOUNT,
    section: 'billing',
    labelKey: 'com_ui_settings_label_auto_refill',
    show: (ctx) => ctx.balanceEnabled,
    Component: AutoRefill,
  },
  // Account · Danger zone
  {
    id: 'deleteAccount',
    tab: ACCOUNT,
    section: 'danger',
    labelKey: 'com_ui_settings_label_delete_account',
    show: (ctx) => ctx.allowAccountDeletion,
    Component: DeleteAccount,
  },
];
