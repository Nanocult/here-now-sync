import { PluginSettingTab, Setting, App, Notice, SecretComponent } from 'obsidian';
import { ApiKeyModal } from './ui/modals/ApiKeyModal';
import HereNowSyncPlugin from './main';
import { SyncLogger } from './utils/logger';

export interface HereNowSyncSettings {
  // Authentication (API key stored in SecretStorage, not here)
  apiKeyLabel: string;
  
  // Sync configuration
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  syncScope: 'entire-vault' | 'specific-folders';
  includedFolders: string[];
  excludedPatterns: string[];
  
  // Storage target
  defaultTarget: 'drive' | 'site';
  driveId?: string;
  siteSlug?: string;
  autoPublishToSite: boolean; // Auto-publish after successful Drive sync
  
  // Conflict resolution
  conflictStrategy: 'timestamp-wins' | 'local-wins' | 'remote-wins' | 'keep-both';
  enableManualMerge: boolean;
  
  // Deletion behavior
  trashFolderName: string;
  
  // Offline & performance
  enableOfflineQueue: boolean;
  maxQueueSize: number;
  throttleLargeFiles: boolean;
  largeFileThresholdMB: number;
  
  // UI preferences
  showNotifications: boolean;
  showDetailedLogs: boolean;
  
  // Advanced
  apiBaseUrl: string; // Allow self-hosted here.now instances
  requestTimeoutMs: number;
}

export const DEFAULT_SETTINGS: HereNowSyncSettings = {
  apiKeyLabel: '',
  
  syncEnabled: true,
  syncIntervalMinutes: 15,
  syncScope: 'entire-vault',
  includedFolders: [],
  excludedPatterns: ['*.tmp', '*.log', '.DS_Store', 'node_modules/**'],
  
  defaultTarget: 'drive',
  driveId: undefined,
  siteSlug: undefined,
  autoPublishToSite: false,
  
  conflictStrategy: 'timestamp-wins',
  enableManualMerge: true,
  
  trashFolderName: '.trash',
  
  enableOfflineQueue: true,
  maxQueueSize: 100,
  throttleLargeFiles: true,
  largeFileThresholdMB: 10,
  
  showNotifications: true,
  showDetailedLogs: false,
  
  apiBaseUrl: 'https://here.now/api/v1',
  requestTimeoutMs: 30000,
};

export class HereNowSyncSettingTab extends PluginSettingTab {
  plugin: HereNowSyncPlugin;

  constructor(app: App, plugin: HereNowSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    // Header
    containerEl.createEl('h2', { text: 'Here.Now Drive Settings' });
    containerEl.createEl('p', { 
      text: 'Sync your Obsidian vault with here.now drives (private) or sites (public).',
      cls: 'mod-info'
    });

    // ===== AUTHENTICATION SECTION =====
    containerEl.createEl('h3', { text: '🔐 Authentication' });

    const infoApiKeyEl = containerEl.createEl('div', { cls: 'mod-info' });
      infoApiKeyEl.style.marginBottom = '12px';
      infoApiKeyEl.innerHTML = 'Get your API key from <a href="https://here.now/dashboard#api-key" target="_blank">here.now dashboard</a>.';

    // Check if SecretStorage is available
    const supportsSecretStorage = !!(this.app as any).keyVault;

    if (!supportsSecretStorage) {
      // Show warning if SecretStorage is not available
      const warningEl = containerEl.createEl('div', { cls: 'setting-item-description' });
      warningEl.style.color = 'var(--text-error)';
      warningEl.style.marginBottom = '12px';
      warningEl.innerHTML = `
        ⚠️ <strong>SecretStorage is not available</strong>: Your Obsidian version does not support secure secret storage. 
        Please upgrade Obsidian to use this plugin securely. The API key will be stored in plugin settings.
      `;

      new Setting(containerEl)
        .setName('here.now API Key')
        .addButton(button => button
          .setButtonText(this.plugin.settings.apiKeyLabel || 'Configure API Key')
          .setCta()
          .onClick(async () => {
            const modal = new ApiKeyModal(this.app, this.plugin);
            modal.open();
          })
        )
        .addExtraButton(button => button
          .setIcon('refresh-cw')
          .setTooltip('Test connection')
          .onClick(async () => {
            const result = await this.plugin.authManager.testConnection();
            if (result.success) {
              new Notice('✅ Connected to here.now successfully');
            } else {
              new Notice(`❌ Connection failed: ${result.error}`);
            }
          })
        );

    } else {
      // Check if any secret exists for here.now
      const hasSecret = await this.plugin.authManager.hasSecretConfigured();

      if (!hasSecret) {
        // Show alert if no secrets exist
        const alertEl = containerEl.createEl('div', { cls: 'setting-item-description mod-warning' });
        alertEl.style.cssText = 'background: var(--background-modifier-error); padding: 12px; border-radius: 8px; margin-bottom: 16px; color: var(--text-normal);';
        alertEl.innerHTML = `
          <p style="margin: 0 0 8px 0; font-weight: 600;">🔐 No API Key Configured</p>
          <p style="margin: 0 0 12px 0;">You need to configure your here.now API key to enable sync functionality.</p>
        `;
        
        const openSecretsBtn = alertEl.createEl('button', { cls: 'mod-cta' });
        openSecretsBtn.textContent = '🔑 Open Secrets Panel';
        openSecretsBtn.style.cssText = 'cursor: pointer; padding: 8px 16px; margin-top: 8px;';
        openSecretsBtn.onclick = async () => {
          // Open Obsidian's built-in Secrets panel
          (this.app as any).setting?.open();
          // Try to navigate to the secrets tab - Obsidian 1.5+
          setTimeout(() => {
            const secretsTab = document.querySelector('[data-tab-id="secrets"]') as HTMLElement;
            if (secretsTab) {
              secretsTab.click();
            } else {
              // Fallback: show instructions
              new Notice('🔑 Please go to Settings → Secrets to add your here.now API key');
            }
          }, 100);
        };
      }
      
      // API Key setting using SecretComponent
      new Setting(containerEl)
        .setName('here.now API Key')
        .setDesc('Select a secret from SecretStorage. Your key is stored securely in your OS keychain.')
        .addComponent(el => new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.apiKeyLabel || '')
          .onChange(async (value) => {
            // The SecretComponent returns the secret name/label, not the actual key
            // We store only the label in settings, the actual key is in SecretStorage
            this.plugin.settings.apiKeyLabel = value;
            await this.plugin.saveSettings();
            
            // If user selected a secret, test the connection
            if (value) {
              const result = await this.plugin.authManager.testConnection();
              if (result.success) {
                new Notice('✅ Connected to here.now successfully');
              } else {
                new Notice(`⚠️ Connection test failed: ${result.error}`);
              }
            }
          })
        )
        .addExtraButton(button => button
          .setIcon('refresh-cw')
          .setTooltip('Test connection')
          .onClick(async () => {
            const result = await this.plugin.authManager.testConnection();
            if (result.success) {
              new Notice('✅ Connected to here.now successfully');
            } else {
              new Notice(`❌ Connection failed: ${result.error}`);
            }
          })
        )
        .addExtraButton(button => button
          .setIcon('trash')
          .setTooltip('Remove API key')
          .onClick(async () => {
            await this.plugin.authManager.clearApiKey();
            this.display(); // Re-render to update UI
            new Notice('🗑️ API key removed');
          })
        );
    }

    // ===== SYNC CONFIGURATION =====
    containerEl.createEl('h3', { text: '🔄 Sync Configuration' });
    
    new Setting(containerEl)
      .setName('Enable Periodic Sync')
      .setDesc('Automatically sync changes at regular intervals')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncEnabled)
        .onChange(async (value) => {
          this.plugin.settings.syncEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync Interval')
      .setDesc('How often to check for changes (when periodic sync is enabled)')
      .addDropdown(dropdown => dropdown
        .addOption('5', 'Every 5 minutes')
        .addOption('15', 'Every 15 minutes')
        .addOption('30', 'Every 30 minutes')
        .addOption('60', 'Every hour')
        .addOption('120', 'Every 2 hours')
        .setValue(this.plugin.settings.syncIntervalMinutes.toString())
        .onChange(async (value) => {
          this.plugin.settings.syncIntervalMinutes = parseInt(value);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync Scope')
      .setDesc('Choose which folders to sync')
      .addDropdown(dropdown => dropdown
        .addOption('entire-vault', 'Entire vault')
        .addOption('specific-folders', 'Specific folders only')
        .setValue(this.plugin.settings.syncScope)
        .onChange(async (value: 'entire-vault' | 'specific-folders') => {
          this.plugin.settings.syncScope = value;
          await this.plugin.saveSettings();
          this.display(); // Re-render to show/hide folder selector
        })
      );

    // Show folder selector only if specific folders mode
    if (this.plugin.settings.syncScope === 'specific-folders') {
      new Setting(containerEl)
        .setName('Included Folders')
        .setDesc('Folders to sync (one per line, relative to vault root)')
        .addTextArea(text => text
          .setPlaceholder('Notes\nProjects/Work\nDiaries')
          .setValue(this.plugin.settings.includedFolders.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.includedFolders = value
              .split('\n')
              .map(f => f.trim())
              .filter(f => f.length > 0);
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName('Exclude Patterns')
      .setDesc('Glob patterns to exclude (e.g., *.tmp, .obsidian/**)')
      .addTextArea(text => text
        .setPlaceholder('*.tmp\n*.log\nnode_modules/**\n.cache/**')
        .setValue(this.plugin.settings.excludedPatterns.join('\n'))
        .onChange(async (value) => {
          this.plugin.settings.excludedPatterns = value
            .split('\n')
            .map(p => p.trim())
            .filter(p => p.length > 0);
          await this.plugin.saveSettings();
        })
      );

    // ===== STORAGE TARGET =====
    containerEl.createEl('h3', { text: '📦 Storage Target' });
    
    new Setting(containerEl)
      .setName('Default Sync Target')
      .setDesc('Where to store synced files')
      .addDropdown(dropdown => dropdown
        .addOption('drive', '🔒 Drive (private storage)')
        .addOption('site', '🌐 Site (public URL)')
        .setValue(this.plugin.settings.defaultTarget)
        .onChange(async (value: 'drive' | 'site') => {
          this.plugin.settings.defaultTarget = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.defaultTarget === 'drive') {
      new Setting(containerEl)
        .setName('Drive ID')
        .setDesc('Optional: Specific Drive ID (leave empty to use default)')
        .addText(text => text
          .setPlaceholder('auto-discover')
          .setValue(this.plugin.settings.driveId || '')
          .onChange(async (value) => {
            this.plugin.settings.driveId = value || undefined;
            await this.plugin.saveSettings();
          })
        );
    }

    if (this.plugin.settings.defaultTarget === 'site' || this.plugin.settings.siteSlug) {
      new Setting(containerEl)
        .setName('Site Slug')
        .setDesc('Your here.now Site slug (e.g., "my-notes") for public publishing')
        .addText(text => text
          .setPlaceholder('my-notes')
          .setValue(this.plugin.settings.siteSlug || '')
          .onChange(async (value) => {
            this.plugin.settings.siteSlug = value || undefined;
            await this.plugin.saveSettings();
          })
        );
    }

    // Auto-publish toggle (only shown when Drive is default but Site is configured)
    if (this.plugin.settings.defaultTarget === 'drive' && this.plugin.settings.siteSlug) {
      new Setting(containerEl)
        .setName('Auto-publish to Site')
        .setDesc('After syncing to Drive, automatically publish snapshot to your Site')
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.autoPublishToSite)
          .onChange(async (value) => {
            this.plugin.settings.autoPublishToSite = value;
            await this.plugin.saveSettings();
          })
        );
    }

    // ===== CONFLICT RESOLUTION =====
    containerEl.createEl('h3', { text: '⚔️ Conflict Resolution' });
    
    new Setting(containerEl)
      .setName('Conflict Strategy')
      .setDesc('When the same file is modified in both locations')
      .addDropdown(dropdown => dropdown
        .addOption('timestamp-wins', '🕐 Newest file wins (last-write-wins)')
        .addOption('local-wins', '💻 Local version always wins')
        .addOption('remote-wins', '☁️ Remote version always wins')
        .addOption('keep-both', '📋 Keep both versions (add .conflict suffix)')
        .setValue(this.plugin.settings.conflictStrategy)
        .onChange(async (value) => {
          this.plugin.settings.conflictStrategy = value as any;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Manual Merge Prompt')
      .setDesc('Show a dialog to manually resolve conflicts when they occur')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableManualMerge)
        .onChange(async (value) => {
          this.plugin.settings.enableManualMerge = value;
          await this.plugin.saveSettings();
        })
      );

    // ===== DELETION BEHAVIOR =====
    containerEl.createEl('h3', { text: '🗑️ Deletion Handling' });
    
    new Setting(containerEl)
      .setName('Trash Folder Name')
      .setDesc('Files deleted locally are moved here instead of being deleted remotely')
      .addText(text => text
        .setValue(this.plugin.settings.trashFolderName)
        .onChange(async (value) => {
          this.plugin.settings.trashFolderName = value || '.trash';
          await this.plugin.saveSettings();
        })
      )
      .addExtraButton(button => button
        .setIcon('info')
        .setTooltip('This folder is automatically excluded from sync')
      );

    // ===== OFFLINE & PERFORMANCE =====
    containerEl.createEl('h3', { text: '⚡ Offline & Performance' });
    
    new Setting(containerEl)
      .setName('Enable Offline Queue')
      .setDesc('Queue changes when offline and sync automatically when reconnected')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableOfflineQueue)
        .onChange(async (value) => {
          this.plugin.settings.enableOfflineQueue = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Throttle Large Files')
      .setDesc('Pause sync of large files on metered connections')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.throttleLargeFiles)
        .onChange(async (value) => {
          this.plugin.settings.throttleLargeFiles = value;
          await this.plugin.saveSettings();
        })
      );

    if (this.plugin.settings.throttleLargeFiles) {
      new Setting(containerEl)
        .setName('Large File Threshold')
        .setDesc('Files larger than this will be throttled (MB)')
        .addText(text => text
          .setValue(this.plugin.settings.largeFileThresholdMB.toString())
          .onChange(async (value: string) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.largeFileThresholdMB = num;
              await this.plugin.saveSettings();
            }
          })
        )
        .then(setting => {
          setting.controlEl.querySelector('input')?.setAttribute('type', 'number');
        });
    }

    // ===== UI PREFERENCES =====
    containerEl.createEl('h3', { text: '🎨 UI Preferences' });
    
    new Setting(containerEl)
      .setName('Show Notifications')
      .setDesc('Display modal notifications for sync events')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showNotifications)
        .onChange(async (value) => {
          this.plugin.settings.showNotifications = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Show Detailed Logs')
      .setDesc('Output verbose sync logs to developer console')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showDetailedLogs)
        .onChange(async (value) => {
          this.plugin.settings.showDetailedLogs = value;
          await this.plugin.saveSettings();
        })
      );

    // ===== DIAGNOSTICS =====
    containerEl.createEl('h3', { text: '📋 Diagnostics' });
    
    new Setting(containerEl)
      .setName('Open Sync Log Panel')
      .setDesc('View sync logs in the right panel with filtering and detailed views')
      .addButton(button => button
        .setButtonText('📋 Open Log Panel')
        .onClick(() => {
          (this.plugin as any).rightPanelManager?.openRightPanel();
        })
      )
      .addButton(button => button
        .setButtonText('🗑️ Clear Logs')
        .onClick(() => {
          SyncLogger.clear();
          new Notice('🗑️ Logs cleared', 3000);
        })
      );

    new Setting(containerEl)
      .setName('Export Logs to File')
      .setDesc('Create a markdown note with all sync logs for troubleshooting')
      .addButton(button => button
        .setButtonText('📤 Export to Note')
        .onClick(async () => {
          const text = SyncLogger.exportAsText();
          const logs = SyncLogger.getLogs();
          
          if (logs.length === 0) {
            new Notice('📋 No logs to export', 3000);
            return;
          }
          
          const fileName = `sync-logs-${new Date().toISOString().split('T')[0]}.md`;
          try {
            await this.plugin.app.vault.create(
              fileName,
              `# here.now Sync Logs\n\nGenerated: ${new Date().toISOString()}\n\n\`\`\`\n${text}\n\`\`\``
            );
            new Notice(`📋 Exported ${logs.length} entries to ${fileName}`, 4000);
          } catch (error: any) {
            new Notice(`❌ Failed to export: ${error.message}`, 4000);
          }
        })
      );
    // ===== ADVANCED =====
    containerEl.createEl('h3', { text: '⚙️ Advanced' });
    
    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc('Custom here.now API endpoint (for self-hosted instances)')
      .addText(text => text
        .setValue(this.plugin.settings.apiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value || 'https://here.now/api/v1';
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Request Timeout')
      .setDesc('Maximum time to wait for API responses (milliseconds)')
      .addText(text => text
        .setValue(this.plugin.settings.requestTimeoutMs.toString())
        .onChange(async (value: string) => {
          const num = parseInt(value);
          if (!isNaN(num) && num > 1000) {
            this.plugin.settings.requestTimeoutMs = num;
            await this.plugin.saveSettings();
          }
        })
      )
      .then(setting => {
        setting.controlEl.querySelector('input')?.setAttribute('type', 'number');
      });

    // Footer
    containerEl.createEl('hr');
    const footer = containerEl.createEl('p', { cls: 'mod-muted' });
    footer.innerHTML = `
      Obsidian <a href="https://github.com/Nanocult/here-now-drive" target="_blank">Here.Now Drive</a> Plugin v${this.plugin.manifest.version} • 
      <a href="https://here.now/docs" target="_blank">here.now Docs</a> • 
      <a href="https://docs.obsidian.md" target="_blank">Obsidian Dev Docs</a>
    `;
  }
}
