const {Router} = require('express');
const body = require('body-parser');
const MagicLink = require('@tryghost/magic-link');
const errors = require('@tryghost/errors');
const logging = require('@tryghost/logging');

const MemberAnalyticsService = require('@tryghost/member-analytics-service');
const MembersAnalyticsIngress = require('@tryghost/members-analytics-ingress');
const PaymentsService = require('@tryghost/members-payments');

const StripeWebhookService = require('./services/stripe-webhook');
const TokenService = require('./services/token');
const GeolocationSerice = require('./services/geolocation');
const MemberBREADService = require('./services/member-bread');
const MemberRepository = require('./repositories/member');
const EventRepository = require('./repositories/event');
const ProductRepository = require('./repositories/product');
const RouterController = require('./controllers/router');
const MemberController = require('./controllers/member');
const WellKnownController = require('./controllers/well-known');

module.exports = function MembersAPI({
    tokenConfig: {
        issuer,
        privateKey,
        publicKey
    },
    auth: {
        allowSelfSignup = () => true,
        getSigninURL,
        tokenProvider
    },
    paymentConfig,
    mail: {
        transporter,
        getText,
        getHTML,
        getSubject
    },
    models: {
        StripeWebhook,
        StripeCustomer,
        StripeCustomerSubscription,
        Member,
        MemberSubscribeEvent,
        MemberLoginEvent,
        MemberPaidSubscriptionEvent,
        MemberPaymentEvent,
        MemberStatusEvent,
        MemberProductEvent,
        MemberEmailChangeEvent,
        MemberAnalyticEvent,
        Offer,
        OfferRedemption,
        StripeProduct,
        StripePrice,
        Product
    },
    stripeAPIService,
    offersAPI,
    labsService
}) {
    const tokenService = new TokenService({
        privateKey,
        publicKey,
        issuer
    });

    const stripeConfig = paymentConfig && paymentConfig.stripe || {};

    const memberAnalyticsService = MemberAnalyticsService.create(MemberAnalyticEvent);
    memberAnalyticsService.eventHandler.setupSubscribers();

    const productRepository = new ProductRepository({
        Product,
        StripeProduct,
        StripePrice,
        stripeAPIService
    });

    const memberRepository = new MemberRepository({
        stripeAPIService,
        tokenService,
        productRepository,
        Member,
        MemberSubscribeEvent,
        MemberPaidSubscriptionEvent,
        MemberEmailChangeEvent,
        MemberStatusEvent,
        MemberProductEvent,
        OfferRedemption,
        StripeCustomer,
        StripeCustomerSubscription
    });

    const eventRepository = new EventRepository({
        MemberSubscribeEvent,
        MemberPaidSubscriptionEvent,
        MemberPaymentEvent,
        MemberStatusEvent,
        MemberLoginEvent
    });

    const memberBREADService = new MemberBREADService({
        offersAPI,
        memberRepository,
        emailService: {
            async sendEmailWithMagicLink({email, requestedType}) {
                return sendEmailWithMagicLink({
                    email,
                    requestedType,
                    options: {
                        forceEmailType: true
                    }
                });
            }
        },
        labsService,
        stripeService: stripeAPIService
    });

    const stripeWebhookService = new StripeWebhookService({
        StripeWebhook,
        stripeAPIService,
        productRepository,
        memberRepository,
        eventRepository,
        /**
         * @param {string} email
         */
        async sendSignupEmail(email) {
            const requestedType = 'signup-paid';
            await sendEmailWithMagicLink({
                email,
                requestedType,
                options: {
                    forceEmailType: true
                },
                tokenData: {}
            });
        }
    });

    const geolocationService = new GeolocationSerice();

    const magicLinkService = new MagicLink({
        transporter,
        tokenProvider,
        getSigninURL,
        getText,
        getHTML,
        getSubject
    });

    const memberController = new MemberController({
        memberRepository,
        StripePrice,
        tokenService,
        sendEmailWithMagicLink
    });

    const paymentsService = new PaymentsService({
        Offer,
        offersAPI,
        stripeAPIService
    });

    const routerController = new RouterController({
        offersAPI,
        paymentsService,
        productRepository,
        memberRepository,
        StripePrice,
        allowSelfSignup,
        magicLinkService,
        stripeAPIService,
        tokenService,
        sendEmailWithMagicLink,
        labsService,
        config: {
            checkoutSuccessUrl: stripeConfig.checkoutSuccessUrl,
            checkoutCancelUrl: stripeConfig.checkoutCancelUrl,
            billingSuccessUrl: stripeConfig.billingSuccessUrl,
            billingCancelUrl: stripeConfig.billingCancelUrl
        }
    });

    const wellKnownController = new WellKnownController({
        tokenService
    });

    async function hasActiveStripeSubscriptions() {
        const firstActiveSubscription = await StripeCustomerSubscription.findOne({
            status: 'active'
        });

        if (firstActiveSubscription) {
            return true;
        }

        const firstTrialingSubscription = await StripeCustomerSubscription.findOne({
            status: 'trialing'
        });

        if (firstTrialingSubscription) {
            return true;
        }

        const firstUnpaidSubscription = await StripeCustomerSubscription.findOne({
            status: 'unpaid'
        });

        if (firstUnpaidSubscription) {
            return true;
        }

        const firstPastDueSubscription = await StripeCustomerSubscription.findOne({
            status: 'past_due'
        });

        if (firstPastDueSubscription) {
            return true;
        }

        return false;
    }

    const users = memberRepository;

    async function sendEmailWithMagicLink({email, requestedType, tokenData, options = {forceEmailType: false}, requestSrc = ''}) {
        let type = requestedType;
        if (!options.forceEmailType) {
            const member = await users.get({email});
            if (member) {
                type = 'signin';
            } else if (type !== 'subscribe') {
                type = 'signup';
            }
        }
        return magicLinkService.sendMagicLink({email, type, requestSrc, tokenData: Object.assign({email}, tokenData)});
    }

    function getMagicLink(email) {
        return magicLinkService.getMagicLink({tokenData: {email}, type: 'signin'});
    }

    async function getMemberDataFromMagicLinkToken(token) {
        const {email, labels = [], name = '', oldEmail} = await magicLinkService.getDataFromToken(token);
        if (!email) {
            return null;
        }

        const member = oldEmail ? await getMemberIdentityData(oldEmail) : await getMemberIdentityData(email);

        if (member) {
            await MemberLoginEvent.add({member_id: member.id});
            if (oldEmail) {
                // user exists but wants to change their email address
                if (oldEmail) {
                    member.email = email;
                }
                await users.update(member, {id: member.id});
                return getMemberIdentityData(email);
            }
            return member;
        }

        const newMember = await users.create({name, email, labels});
        await MemberLoginEvent.add({member_id: newMember.id});
        return getMemberIdentityData(email);
    }

    async function getMemberIdentityData(email) {
        return memberBREADService.read({email});
    }

    async function getMemberIdentityToken(email) {
        const member = await getMemberIdentityData(email);
        if (!member) {
            return null;
        }
        return tokenService.encodeIdentityToken({sub: member.email});
    }

    async function setMemberGeolocationFromIp(email, ip) {
        if (!email || !ip) {
            throw new errors.IncorrectUsageError({
                message: 'setMemberGeolocationFromIp() expects email and ip arguments to be present'
            });
        }

        // toJSON() is needed here otherwise users.update() will pick methods off
        // the model object rather than data and fail to edit correctly
        const member = (await users.get({email})).toJSON();

        if (!member) {
            throw new errors.NotFoundError({
                message: `Member with email address ${email} does not exist`
            });
        }

        // max request time is 500ms so shouldn't slow requests down too much
        let geolocation = JSON.stringify(await geolocationService.getGeolocationFromIP(ip));
        if (geolocation) {
            member.geolocation = geolocation;
            await users.update(member, {id: member.id});
        }

        return getMemberIdentityData(email);
    }

    const middleware = {
        sendMagicLink: Router().use(
            body.json(),
            (req, res) => routerController.sendMagicLink(req, res)
        ),
        createCheckoutSession: Router().use(
            body.json(),
            (req, res) => routerController.createCheckoutSession(req, res)
        ),
        createCheckoutSetupSession: Router().use(
            body.json(),
            (req, res) => routerController.createCheckoutSetupSession(req, res)
        ),
        createEvents: Router().use(
            body.json(),
            (req, res) => MembersAnalyticsIngress.createEvents(req, res)
        ),
        updateEmailAddress: Router().use(
            body.json(),
            (req, res) => memberController.updateEmailAddress(req, res)
        ),
        updateSubscription: Router({mergeParams: true}).use(
            body.json(),
            (req, res) => memberController.updateSubscription(req, res)
        ),
        handleStripeWebhook: Router(),
        wellKnown: Router()
            .get('/jwks.json',
                (req, res) => wellKnownController.getPublicKeys(req, res)
            )
    };

    middleware.handleStripeWebhook.use(body.raw({type: 'application/json'}), async function (req, res) {
        if (!stripeAPIService.configured) {
            logging.error(`Stripe not configured, not handling webhook`);
            res.writeHead(400);
            return res.end();
        }

        if (!req.body || !req.headers['stripe-signature']) {
            res.writeHead(400);
            return res.end();
        }
        let event;
        try {
            event = stripeWebhookService.parseWebhook(req.body, req.headers['stripe-signature']);
        } catch (err) {
            logging.error(err);
            res.writeHead(401);
            return res.end();
        }
        logging.info(`Handling webhook ${event.type}`);
        try {
            await stripeWebhookService.handleWebhook(event);
            res.writeHead(200);
            res.end();
        } catch (err) {
            logging.error(`Error handling webhook ${event.type}`, err);
            res.writeHead(err.statusCode || 500);
            res.end();
        }
    });

    const getPublicConfig = function () {
        return Promise.resolve({
            publicKey,
            issuer
        });
    };

    const bus = new (require('events').EventEmitter)();

    bus.emit('ready');

    return {
        middleware,
        getMemberDataFromMagicLinkToken,
        getMemberIdentityToken,
        getMemberIdentityData,
        setMemberGeolocationFromIp,
        getPublicConfig,
        bus,
        sendEmailWithMagicLink,
        getMagicLink,
        hasActiveStripeSubscriptions,
        members: users,
        memberBREADService,
        events: eventRepository,
        productRepository
    };
};
