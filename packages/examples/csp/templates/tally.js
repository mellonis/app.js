export default {
    data: () => ({count: 0}),
    methods: {
        bump() {
            this.data.count += 1;
        },
    },
};
