require("dotenv").config();
const crypto = require("node:crypto");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const requiredEnv = [
  "DISCORD_TOKEN",
  "GUILD_ID",
  "APPLICATION_CHANNEL_ID",
  "MODERATOR_ROLE_ID"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Environment variable ${key} is required.`);
  }
}

const APPLICATION_BUTTON_ID = "unlowed_apply";
const APPLICATION_MODAL_ID = "unlowed_application_modal";
const ACTION_PREFIX = "unlowed_application_action";
const INSPECTION_ALLOWED_ROLE_IDS = [
  "1486047078584160266",
  "1486047078558990579"
];
const NEWS_ALLOWED_ROLE_IDS = [
  "1486047078584160267",
  "1486047078558990578"
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

async function registerCommands(guild) {
  const commands = [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Отправить панель заявок Unlowed.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("news")
      .setDescription("Отправить ЛС-рассылку участникам выбранной роли.")
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Роль получателей.")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription("Текст, который нужно отправить в ЛС.")
          .setRequired(true)
      )
  ].map((cmd) => cmd.toJSON());

  await guild.commands.set(commands);
}

function buildApplicationPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("FamilyHelper")
    .setDescription(
      "Для того, чтобы подать заявку в **Unlowed FAMQ**, нажмите на кнопку ниже."
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(APPLICATION_BUTTON_ID)
      .setLabel("Подать заявку")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

function buildModerationButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ACTION_PREFIX}:accepted`)
      .setLabel("Принять")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${ACTION_PREFIX}:reviewing`)
      .setLabel("Взять на рассмотрение")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${ACTION_PREFIX}:inspection`)
      .setLabel("Вызвать на обзор")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${ACTION_PREFIX}:rejected`)
      .setLabel("Отклонить")
      .setStyle(ButtonStyle.Danger)
  );
}

function extractApplicantIdFromMessage(message) {
  const embedDescription = message.embeds?.[0]?.description;
  if (!embedDescription) return null;

  const mentionMatch = embedDescription.match(/<@!?(\d+)>/);
  return mentionMatch ? mentionMatch[1] : null;
}

function buildApplicationModal() {
  const modal = new ModalBuilder()
    .setCustomId(APPLICATION_MODAL_ID)
    .setTitle("Заявка на вступление в семью");

  const fields = [
    new TextInputBuilder()
      .setCustomId("name_age")
      .setLabel("Имя и возраст")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Пример: Malenki, 14")
      .setMaxLength(80)
      .setRequired(true),
    new TextInputBuilder()
      .setCustomId("archives")
      .setLabel("1-2 архива")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(200)
      .setRequired(true),
    new TextInputBuilder()
      .setCustomId("families")
      .setLabel("В каких семьях вы были?")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(300)
      .setRequired(true),
    new TextInputBuilder()
      .setCustomId("prime_hours")
      .setLabel("Прайм тайм и сколько часов")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Пример: 18:00-22:00, 6 часов")
      .setMaxLength(100)
      .setRequired(true),
    new TextInputBuilder()
      .setCustomId("had_chs")
      .setLabel("Были ли ЧС")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(100)
      .setRequired(true)
  ];

  for (const field of fields) {
    modal.addComponents(new ActionRowBuilder().addComponents(field));
  }

  return modal;
}

async function notifyModerators(guild, content) {
  const role = guild.roles.cache.get(process.env.MODERATOR_ROLE_ID);
  if (!role) return;

  await guild.members.fetch();
  const usersToNotify = role.members.filter((m) => !m.user.bot);
  for (const member of usersToNotify.values()) {
    try {
      await member.send(content);
    } catch (error) {
      // Ignore DMs blocked by user privacy settings.
    }
  }
}

async function createDiscussionChannel(guild, applicant, sourceChannel) {
  const requestedCategoryId =
    process.env.APPLICATION_CATEGORY_ID || sourceChannel.parentId;
  const category = requestedCategoryId
    ? guild.channels.cache.get(requestedCategoryId) ||
      (await guild.channels.fetch(requestedCategoryId).catch(() => null))
    : null;
  const moderatorRole = guild.roles.cache.get(process.env.MODERATOR_ROLE_ID);
  const safeUsernamePart = applicant.user.username
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const applicantChannelName = `application-${safeUsernamePart || applicant.id}`.slice(
    0,
    100
  );
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: applicant.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];
  if (moderatorRole) {
    permissionOverwrites.push({
      id: moderatorRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages
      ]
    });
  } else {
    console.warn(
      "MODERATOR_ROLE_ID does not point to an existing role. Creating channel without moderator overwrite."
    );
  }

  const channel = await guild.channels.create({
    name: applicantChannelName,
    type: ChannelType.GuildText,
    parent: category?.id || null,
    topic: `Канал рассмотрения заявки от ${applicant.user.tag} (${applicant.id})`,
    permissionOverwrites
  });

  await channel.send(
    `Канал заявки создан для ${applicant}. Пишите детали рассмотрения здесь.`
  );

  return channel;
}

client.once("clientReady", async () => {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await registerCommands(guild);
  console.log(`Unlowed bot online as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        await interaction.channel.send(buildApplicationPanel());
        await interaction.reply({
          content: "Панель заявок Unlowed отправлена в этот канал.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "news") {
        const senderMember = await interaction.guild.members.fetch(
          interaction.user.id
        );
        const canUseNews = NEWS_ALLOWED_ROLE_IDS.some((roleId) =>
          senderMember.roles.cache.has(roleId)
        );
        if (!canUseNews && !senderMember.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({
            content: "У вас нет прав для использования команды /news.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const role = interaction.options.getRole("role", true);
        const text = interaction.options.getString("text", true);
        const members = role.members.filter((member) => !member.user.bot);

        if (members.size === 0) {
          await interaction.reply({
            content: "У этой роли нет участников для рассылки.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        let success = 0;
        let failed = 0;
        for (const member of members.values()) {
          try {
            await member.send(`**Unlowed news**\n${text}`);
            success += 1;
          } catch (error) {
            failed += 1;
          }
        }

        await interaction.reply({
          content: `Рассылка завершена. Успешно: ${success}, не доставлено: ${failed}.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === APPLICATION_BUTTON_ID) {
        await interaction.showModal(buildApplicationModal());
        return;
      }

      if (interaction.customId.startsWith(`${ACTION_PREFIX}:`)) {
        const action = interaction.customId.split(":")[1];
        if (action === "inspection") {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          const canUseInspection = INSPECTION_ALLOWED_ROLE_IDS.some((roleId) =>
            member.roles.cache.has(roleId)
          );
          if (!canUseInspection && !member.permissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({
              content: "У вас нет прав использовать кнопку «Вызвать на обзор».",
              flags: MessageFlags.Ephemeral
            });
            return;
          }
        }

        const actionText = {
          accepted: "Принять",
          reviewing: "Взять на рассмотрение",
          inspection: "Вызвать на обзор",
          rejected: "Отклонить"
        }[action];

        if (action === "inspection") {
          const applicantId = extractApplicantIdFromMessage(interaction.message);
          if (applicantId) {
            try {
              const applicant = await interaction.guild.members.fetch(applicantId);
              await applicant.send(
                `Ваша заявка в Unlowed вызвана на обзвон. Модератор: ${interaction.user}. Пожалуйста, свяжитесь с администрацией.`
              );
            } catch (notifyError) {
              console.error("Failed to notify applicant about inspection:", notifyError);
            }
          }
        }

        await interaction.reply({
          content: `Статус заявки обновлен: **${actionText || "неизвестно"}** модератором ${interaction.user}.`,
          allowedMentions: { parse: [] }
        });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId !== APPLICATION_MODAL_ID) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const targetChannel = await interaction.guild.channels.fetch(
        process.env.APPLICATION_CHANNEL_ID
      );
      if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        await interaction.editReply({
          content:
            "Канал для заявок не найден или не является текстовым. Проверьте APPLICATION_CHANNEL_ID."
        });
        return;
      }

      const appId = crypto.randomUUID();
      const summary = [
        `**Кто подал**`,
        `${interaction.user}`,
        "",
        `**Имя / возраст**`,
        interaction.fields.getTextInputValue("name_age"),
        "",
        `**1-2 архива**`,
        interaction.fields.getTextInputValue("archives"),
        "",
        `**В каких семьях вы были**`,
        interaction.fields.getTextInputValue("families"),
        "",
        `**Прайм тайм и сколько часов**`,
        interaction.fields.getTextInputValue("prime_hours"),
        "",
        `**Были ли ЧС**`,
        interaction.fields.getTextInputValue("had_chs"),
        "",
        `ApplicationId: \`${appId}\` • В очереди на модерацию`
      ].join("\n");

      const embed = new EmbedBuilder()
        .setColor(0x2f3136)
        .setTitle("Заявка на вступление в семью")
        .setDescription(summary);

      const msg = await targetChannel.send({
        content: "Модераторы, обработайте заявку.",
        embeds: [embed],
        components: [buildModerationButtons()]
      });

      const applicantMember = await interaction.guild.members.fetch(
        interaction.user.id
      );
      let discussionChannel;
      try {
        discussionChannel = await createDiscussionChannel(
          interaction.guild,
          applicantMember,
          targetChannel
        );
      } catch (channelError) {
        console.error("Failed to create discussion channel:", channelError);
        await interaction.editReply({
          content:
            "Заявка отправлена, но канал обсуждения не создан. Проверьте права бота (`Manage Channels`) и корректность MODERATOR_ROLE_ID/APPLICATION_CATEGORY_ID."
        });
        return;
      }
      await targetChannel.send(
        `Создан канал рассмотрения: ${discussionChannel} для ${interaction.user}.`
      );

      try {
        await notifyModerators(
          interaction.guild,
          `Обнаружена новая заявка Unlowed: ${msg.url}\nКанал рассмотрения: ${discussionChannel.url}`
        );
      } catch (notifyError) {
        console.error("Failed to notify moderators:", notifyError);
      }

      await interaction.editReply({
        content: "Заявка отправлена. Ожидайте ответ модераторов."
      });
    }
  } catch (error) {
    console.error("Interaction error:", error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: "Произошла ошибка при обработке команды.",
          flags: MessageFlags.Ephemeral
        });
      } catch (replyError) {
        console.error("Failed to reply with error:", replyError);
      }
    }
  }
});

client.on("error", (error) => {
  console.error("Client error:", error);
});

client.login(process.env.DISCORD_TOKEN);
